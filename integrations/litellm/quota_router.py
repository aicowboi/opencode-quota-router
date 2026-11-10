"""quota-router for LiteLLM: route around provider limits in a LiteLLM Router or Proxy.

When a deployment fails, the error is classified the way the quota-router OpenCode plugin does it (a short rate
limit, a plan window that ran out until a known time, an exhausted balance, an outage) and the deployment's pool is
set aside until it is expected back. While a pool is set aside, the Router's other deployments for the same model
group are used instead. Nothing is sent anywhere and nothing is stored on disk.

Install: copy this file next to your proxy config (or anywhere on PYTHONPATH) and add to config.yaml:

    litellm_settings:
      callbacks: quota_router.proxy_handler_instance

or, with the Python SDK:

    import litellm, quota_router
    litellm.callbacks = [quota_router.QuotaRouter()]

Works with LiteLLM's per-attempt deployment hooks (``async_post_call_failure_deployment_hook``) and routing filter
(``async_filter_deployments``). The classifier is a port of ``src/engine/classify.ts`` and is tested against the same
invented cases (``test/fixtures/classify.json``). MIT licence, part of https://github.com/aicowboi/opencode-quota-router.
"""

from __future__ import annotations

import email.utils
import hashlib
import json
import math
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional

try:  # LiteLLM is only needed to run inside it; the classifier and the tests work without it.
    from litellm.integrations.custom_logger import CustomLogger as _Base
except Exception:  # pragma: no cover - exercised when LiteLLM is not installed
    _Base = object  # type: ignore[misc,assignment]

__all__ = ["QuotaRouter", "classify", "model_pools", "proxy_handler_instance"]
__version__ = "0.2.0"

HOUR = 3_600_000
DAY = 24 * HOUR

# ---------------------------------------------------------------------------------------------------------------------
# Reset times (port of src/engine/resets.ts)
# ---------------------------------------------------------------------------------------------------------------------

_WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
_MAX_AHEAD = 8 * DAY


def _plausible(at: Optional[float], now: int) -> bool:
    return at is not None and math.isfinite(at) and now - 60_000 < at < now + 40 * DAY


def _parse_date(value: str) -> Optional[int]:
    """Epoch ms from an ISO 8601 or HTTP date, like JavaScript's Date.parse for the formats providers use."""
    s = value.strip()
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00") if s.endswith("Z") else s)
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc) if "T" not in s else d.astimezone()
        return int(d.timestamp() * 1000)
    except ValueError:
        pass
    try:
        return int(email.utils.parsedate_to_datetime(s).timestamp() * 1000)
    except (TypeError, ValueError, IndexError):
        return None


def next_month_utc(now: int) -> int:
    d = datetime.fromtimestamp(now / 1000, timezone.utc)
    year, month = (d.year + 1, 1) if d.month == 12 else (d.year, d.month + 1)
    return int(datetime(year, month, 1, tzinfo=timezone.utc).timestamp() * 1000)


def next_midnight_in(tz: str, now: int) -> int:
    """The next midnight in a time zone (Gemini's daily quotas reset at midnight Pacific)."""
    from zoneinfo import ZoneInfo

    zone = ZoneInfo(tz)
    local = datetime.fromtimestamp(now / 1000, zone)
    tomorrow = (local + timedelta(days=1)).date()
    return int(datetime(tomorrow.year, tomorrow.month, tomorrow.day, tzinfo=zone).timestamp() * 1000)


def parse_duration(value: Optional[str]) -> Optional[int]:
    """Go-style durations: ``1s``, ``6m0s``, ``250ms``, ``1h2m3.5s``."""
    if not value:
        return None
    total, matched = 0.0, False
    for n, unit in re.findall(r"(\d+(?:\.\d+)?)(ms|h|m|s)", value):
        matched = True
        n = float(n)
        total += n * HOUR if unit == "h" else n * 60_000 if unit == "m" else n * 1000 if unit == "s" else n
    return math.ceil(total) if matched else None


def parse_retry_text(text: str) -> Optional[int]:
    """A wait given in words: ``retry after 26 seconds``, ``Please retry in 34.07s``, ``try again in 6m0s``."""
    m = re.search(
        r"(?:retry|try again|wait)\s+(?:after|in|for)\s+(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|h)(\d+(?:\.\d+)?(?:ms|s|m))?\b",
        text,
        re.I,
    )
    if not m:
        return None
    unit = m.group(2).lower()
    short = "ms" if unit.startswith("mil") or unit == "ms" else "s" if unit.startswith("s") else "m" if unit.startswith("m") else "h"
    return parse_duration(f"{m.group(1)}{short}{m.group(3) or ''}")


def parse_retry_after(value: Optional[str], now: int) -> Optional[int]:
    """``retry-after`` values: seconds, or an HTTP date."""
    if not value:
        return None
    s = str(value).strip()
    if re.fullmatch(r"\d+(\.\d+)?", s):
        return max(0, math.ceil(float(s) * 1000))
    at = _parse_date(s)
    return max(0, at - now) if at is not None else None


def parse_timestamp(value: Any, now: int) -> Optional[int]:
    """Epoch seconds, epoch ms, or an ISO date; only plausible reset times."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        ms = value * 1000 if value < 1e12 else value
        return int(ms) if _plausible(ms, now) else None
    if not isinstance(value, str) or not value.strip():
        return None
    s = value.strip()
    if re.fullmatch(r"\d{9,13}", s):
        return parse_timestamp(int(s), now)
    ms = _parse_date(s)
    return ms if _plausible(ms, now) else None


def parse_reset_text(text: str, now: int) -> Optional[int]:
    """Reset time from free text (``Resets at <ISO>``, ``resets 3pm``, ``|<epoch>``, ``regain access on <date>``)."""
    m = re.search(r"resets?\s+(?:at\s+)?(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)", text, re.I)
    if m:
        at = parse_timestamp(m.group(1), now)
        if at is not None:
            return at
    m = re.search(r"\|(\d{10,13})\b", text)
    if m:
        at = parse_timestamp(int(m.group(1)), now)
        if at is not None:
            return at
    m = re.search(r"regain access on (\d{4}-\d{2}-\d{2})(?: at (\d{1,2}):(\d{2}) UTC)?", text, re.I)
    if m:
        at = _parse_date(f"{m.group(1)}T{(m.group(2) or '0').zfill(2)}:{m.group(3) or '00'}:00Z")
        if _plausible(at, now):
            return at
    m = re.search(r"resets?\s+(?:at\s+)?(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?,?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?", text, re.I)
    if m and (m.group(4) or m.group(3)):
        hour, minute = int(m.group(2)), int(m.group(3) or 0)
        meridiem = (m.group(4) or "").lower()
        if meridiem == "pm" and hour < 12:
            hour += 12
        if meridiem == "am" and hour == 12:
            hour = 0
        if hour > 23 or minute > 59:
            return None
        base = datetime.fromtimestamp(now / 1000)  # local time, as the message means
        candidate = base.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if m.group(1):
            target = _WEEKDAYS.index(m.group(1).lower()[:3])
            days = (target - (candidate.weekday() + 1) % 7 + 7) % 7
            if days == 0 and candidate.timestamp() * 1000 <= now:
                days = 7
            candidate += timedelta(days=days)
        elif candidate.timestamp() * 1000 <= now:
            candidate += timedelta(days=1)
        at = int(candidate.timestamp() * 1000)
        return at if at - now <= _MAX_AHEAD else None
    return None


# ---------------------------------------------------------------------------------------------------------------------
# Classifier (port of src/engine/classify.ts). `error` is {type, message, status?, response?: {body}, retryAfterMs?}.
# ---------------------------------------------------------------------------------------------------------------------

_NEVER_ROUTE = {
    "aborted", "provider.content-filter", "provider.invalid-output", "provider.unsupported-operation", "provider.no-route",
    "output-limit", "permission.rejected", "tool.execution", "compaction.unavailable", "compaction.failed",
}
_IGNORE = [re.compile(r"draw from your extra usage", re.I), re.compile(r"not your (?:plan|usage) limit", re.I)]
_CONTEXT_OVERFLOW = re.compile(r"prompt is too long|context(?: window|[_ ]length)[_ ]?(?:exceeded)?|maximum context length|too many tokens in request", re.I)
_PER_MODEL = {"google", "google-vertex", "google-vertex-anthropic", "amazon-bedrock", "azure", "azure-cognitive-services", "openrouter"}


def model_pools(provider: str, model: str) -> list[str]:
    """The pool(s) a model draws from: per model where the provider limits each model on its own."""
    if provider == "claude-agent":
        m = re.search(r"opus|fable|sonnet|haiku", model, re.I)
        return [provider, f"{provider}:{m.group(0).lower()}"] if m else [provider]
    if provider in _PER_MODEL:
        pools = [provider, f"{provider}:{model}"]
        if provider == "openrouter" and model.endswith(":free"):
            pools.append("openrouter:free")
        return pools
    return [provider]


def _body(error: dict) -> str:
    return ((error.get("response") or {}).get("body")) or ""


def _visit(body: str, pick: Callable[[str, Any], bool]) -> list:
    found: list = []

    def walk(o: Any) -> None:
        if isinstance(o, dict):
            for k, v in o.items():
                if pick(k, v):
                    found.append(v)
                elif isinstance(v, (dict, list)):
                    walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    try:
        walk(json.loads(body))
    except (ValueError, TypeError):
        pass
    return found


def _body_codes(error: dict) -> str:
    return " ".join(_visit(_body(error), lambda k, v: k in ("code", "type", "error_code") and isinstance(v, str))).lower()


def _body_number(error: dict, key: str) -> Optional[float]:
    hits = _visit(_body(error), lambda k, v: k == key and (isinstance(v, (int, float)) and not isinstance(v, bool) or isinstance(v, str) and v.isdigit()))
    return float(hits[0]) if hits else None


def _body_string(error: dict, key: str) -> Optional[str]:
    hits = _visit(_body(error), lambda k, v: k == key and isinstance(v, str))
    return hits[0] if hits else None


def _signal(kind: str, pools: list[str], evidence: str, **extra: Any) -> dict:
    return {"kind": kind, "pools": pools, "evidence": evidence, **{k: v for k, v in extra.items() if v is not None}}


def _search(pattern: str, text: str, flags: int = re.I) -> Optional[re.Match]:
    return re.search(pattern, text, flags)


def _wait(error: dict, text: str) -> Optional[int]:
    return error.get("retryAfterMs") if error.get("retryAfterMs") is not None else parse_retry_text(text)


def _claude_agent(error: dict, text: str, pools: list[str], now: int) -> Optional[dict]:
    reset_at = parse_reset_text(text, now)
    scope = _search(r"\((?:seven[ _]day[ _])?(opus|sonnet|fable)\)|hit your (opus|sonnet|fable) limit|(opus|sonnet|fable) limit reached", text)
    family = next((g.lower() for g in (scope.groups() if scope else ()) if g), None)
    scoped = [f"claude-agent:{family}"] if family else ["claude-agent"]
    if _search(r"credits required|extra[- ]usage|usage credits|monthly spend limit|spend limit reached|billing", text) and not _search(r"limit reached \(", text):
        return _signal("billing", scoped, "Claude usage credits or spend limit", resetAt=reset_at)
    if _search(r"subscription limit reached|usage limit|hit your (?:session|weekly|opus|sonnet|fable) limit|limit reached|out of (?:extra )?usage", text):
        m = _search(r"\(([a-z _]+)\)", text)
        label = m.group(1) if m else ("session" if _search("session", text) else "weekly" if _search("weekly", text) else "window")
        return _signal("window", scoped, f"Claude subscription limit ({label.replace('_', ' ')})", resetAt=reset_at)
    if _search(r"overloaded|\b529\b|HTTP 5\d\d|exhausted its retries", text):
        return _signal("overload", pools, "Anthropic overloaded")
    if _search(r"rate[- ]?limit|too many requests|temporarily limiting", text):
        return _signal("throttle", pools, "Claude rate limit", retryAfterMs=error.get("retryAfterMs"))
    return None


def _anthropic(error: dict, text: str, codes: str, pools: list[str], now: int) -> Optional[dict]:
    if "enforced_spend_limit_reached" in codes or _search(r"regain access on", text):
        return _signal("billing", pools, "Anthropic monthly spend cap", resetAt=parse_reset_text(text, now) or next_month_utc(now))
    if _search(r"specified (?:workspace )?api usage limits", text):
        return _signal("billing", pools, "Anthropic workspace spend limit")
    if _search(r"credit balance is too low", text) or error.get("status") == 402 or "billing_error" in codes:
        return _signal("billing", pools, "Anthropic credit balance")
    if error.get("status") == 529 or "overloaded_error" in codes:
        return _signal("overload", pools, "Anthropic overloaded")
    return None


def _xai(error: dict, text: str, codes: str, pools: list[str]) -> Optional[dict]:
    if _search(r"used all available credits|spending[- ]limit|personal-team-blocked|need a grok subscription|run out of credits", text) or "spending-limit" in codes:
        return _signal("window", pools, "xAI weekly pool or credits used up")
    if "resource-exhausted" in codes and "0/0" in text:
        return _signal("auth", pools, "xAI token not entitled for this endpoint")
    if error.get("status") == 429:
        return _signal("throttle", pools, "xAI rate limit", retryAfterMs=error.get("retryAfterMs"))
    return None


def _copilot(error: dict, text: str, codes: str, pools: list[str], now: int) -> Optional[dict]:
    if error.get("status") == 402 or "quota_exceeded" in codes or _search(r"exceeded your monthly quota", text):
        after = error.get("retryAfterMs")
        reset_at = now + after if after is not None and after > HOUR else next_month_utc(now)
        return _signal("billing", pools, "Copilot monthly allowance used", resetAt=reset_at)
    if "user_global_rate_limited" in codes or _search(r"global rate limit", text):
        return _signal("window", pools, "Copilot global rate limit", retryAfterMs=error.get("retryAfterMs"))
    return None


def _openai(error: dict, text: str, codes: str, pools: list[str], now: int) -> Optional[dict]:
    if "usage_limit_reached" in codes or error.get("type") == "provider.chatgpt-limit":
        after = _body_number(error, "resets_in_seconds")
        reset_at = parse_timestamp(_body_number(error, "resets_at"), now)
        if reset_at is None:
            reset_at = int(now + after * 1000) if after is not None else parse_reset_text(text, now)
        plan = _search(r'"plan_type"\s*:\s*"([a-z_]+)"', _body(error))
        return _signal("window", pools, f"ChatGPT{' ' + plan.group(1) if plan else ''} usage limit", resetAt=reset_at)
    if "usage_not_included" in codes:
        return _signal("billing", pools, "ChatGPT plan does not include this model")
    if re.search(r"insufficient_quota|credit_balance_exhausted|organization_usage_limit_exceeded|spend_limit_exceeded", codes) or _search(r"exceeded your current quota", text):
        monthly = re.search(r"usage_limit|spend_limit", codes)
        return _signal("billing", pools, "OpenAI quota or spend limit", resetAt=next_month_utc(now) if monthly else None)
    if error.get("status") == 503 or "server_is_overloaded" in codes:
        return _signal("overload", pools, "OpenAI overloaded")
    return None


def _gemini(error: dict, text: str, provider: str, model: str, now: int) -> Optional[dict]:
    pools = [f"{provider}:{model}"]
    if error.get("status") == 402 or _search(r"payment_required|billing (?:account|is not enabled|has been disabled)|prepayment credits", text):
        return _signal("billing", [provider], "Gemini billing or credit")
    if error.get("status") == 429 or _search(r"resource_exhausted|quota_exceeded|rate_limit_exceeded|too_many_requests|quota exceeded", text):
        delay = parse_duration(_body_string(error, "retryDelay"))
        if delay is None:
            delay = _wait(error, text)
        if _search(r"per_?day|daily|quota_exceeded", text):
            free = _search(r"free[_-]?tier", text)
            return _signal("window", pools, f"Gemini daily limit{' (free tier)' if free else ''}", resetAt=next_midnight_in("America/Los_Angeles", now))
        return _signal("throttle", pools, "Gemini rate limit", retryAfterMs=delay)
    if error.get("status") == 503 or _search(r'"UNAVAILABLE"|model is overloaded', text):
        return _signal("overload", pools, "Gemini overloaded")
    return None


def _vertex(error: dict, text: str, provider: str, model: str) -> Optional[dict]:
    pools = [f"{provider}:{model}"]
    if error.get("status") == 429 or _search(r"resource[_ ]exhausted|quota exceeded", text):
        return _signal("throttle", pools, "Vertex AI resource exhausted", retryAfterMs=_wait(error, text))
    if error.get("status") == 503 or _search(r'"UNAVAILABLE"|overloaded', text):
        return _signal("overload", pools, "Vertex AI unavailable")
    return None


def _openrouter(error: dict, text: str, model: str, now: int) -> Optional[dict]:
    pools = [f"openrouter:{model}"]

    def reset() -> Optional[int]:
        for v in (_body_number(error, "resets_at"), _body_string(error, "resets_at"), _body_number(error, "X-RateLimit-Reset")):
            if v is not None:
                return parse_timestamp(v, now)
        return None

    m = _search(r"free-models-per-(day|min)", text)
    free = m.group(1).lower() if m else None
    if free == "day":
        return _signal("window", ["openrouter:free"], "OpenRouter daily allowance for free models", resetAt=reset())
    if free == "min":
        return _signal("throttle", ["openrouter:free"], "OpenRouter rate limit for free models", retryAfterMs=_wait(error, text))
    source = _body_string(error, "limit_source")
    if source == "openrouter_in_flight_budget" or _search(r"in_flight_budget_exhausted", text):
        return _signal("throttle", ["openrouter"], "OpenRouter in-flight budget", retryAfterMs=_wait(error, text))
    if source == "openrouter_credits":
        return _signal("billing", ["openrouter"], "OpenRouter credit used up")
    if source or _search(r"key limit exceeded|limit exceeded for (?:this )?key", text):
        what = re.sub(r"^openrouter_", "", source or "key_limit").replace("_", " ")
        return _signal("billing", ["openrouter"], f"OpenRouter {what} reached", resetAt=reset())
    if error.get("status") == 402 or _search(r"insufficient credits|requires more credits|negative credit balance", text):
        return _signal("billing", ["openrouter"], "OpenRouter credit used up")
    if error.get("status") == 429:
        return _signal("throttle", pools, "OpenRouter rate limit", retryAfterMs=_wait(error, text))
    if error.get("status") in (502, 503) or _search(r"no (?:available|allowed) (?:model )?providers?", text):
        return _signal("overload", pools, "OpenRouter has no provider available for this model")
    return None


def _azure(error: dict, text: str, codes: str, provider: str, model: str) -> Optional[dict]:
    pools = [f"{provider}:{model}"]
    if re.search(r"insufficient_quota|quota_exceeded|outofquota", codes.replace(" ", "")) or _search(r"out of (?:call volume )?quota|exceeded your current quota", text):
        return _signal("billing", [provider], "Azure quota used up")
    if error.get("status") == 429 or _search(r"exceeded (?:token|call|request) rate limit", text):
        return _signal("throttle", pools, "Azure rate limit", retryAfterMs=_wait(error, text))
    if error.get("status") == 503 or _search(r"server_?busy|servicebusy|temporarily unable", text):
        return _signal("overload", pools, "Azure deployment busy", retryAfterMs=_wait(error, text))
    return None


def _bedrock(error: dict, text: str, model: str) -> Optional[dict]:
    pools = [f"amazon-bedrock:{model}"]
    if _search(r"too many tokens per day|tokens per day", text):
        return _signal("window", pools, "Bedrock daily token quota")
    if _search(r"ServiceQuotaExceededException", text):
        return _signal("window", pools, "Bedrock service quota")
    if _search(r"ThrottlingException|TooManyRequestsException|too many requests", text) or error.get("status") == 429:
        return _signal("throttle", pools, "Bedrock throttled", retryAfterMs=_wait(error, text))
    if _search(r"ServiceUnavailableException|ModelNotReadyException|ModelTimeoutException|ModelStreamErrorException|InternalServerException", text):
        what = "model not ready" if _search("ModelNotReady", text) else "model timed out" if _search("ModelTimeout", text) else "unavailable"
        return _signal("overload", pools, f"Bedrock {what}")
    if _search(r"ExpiredTokenException|UnrecognizedClientException|InvalidSignatureException|security token .* (?:expired|invalid)", text):
        return _signal("auth", ["amazon-bedrock"], "AWS credentials expired or invalid")
    return None


def _plan(error: dict, text: str, name: str, pools: list[str], now: int) -> Optional[dict]:
    m = _search(r"\b(hourly|5[- ]hour|five[- ]hour|session|daily|weekly|monthly)\b[^.\n]{0,24}\b(?:limit|usage|allowance|quota)", text)
    scope = m.group(1).lower() if m else None
    etype = error.get("type")
    limited = etype in ("provider.go-limit", "provider.free-limit") or scope is not None
    if (_search(r"insufficient (?:balance|credits?)|out of credits?|add (?:more )?credits?|payment required|billing", text) and not scope) or etype == "provider.budget-limit" or (error.get("status") == 402 and not limited):
        return _signal("billing", pools, f"{name} balance or spend limit", resetAt=parse_reset_text(text, now))
    if not limited:
        return None
    reset_at = None
    for v in (_body_number(error, "resets_at"), _body_string(error, "resets_at"), _body_number(error, "resetAt"), _body_string(error, "resetAt")):
        if v is not None:
            reset_at = parse_timestamp(v, now)
            break
    if reset_at is None:
        reset_at = parse_reset_text(text, now)
    if reset_at is None:
        reset_at = next_month_utc(now) if scope == "monthly" else now + HOUR if scope == "hourly" else None
    what = "free allowance" if etype == "provider.free-limit" else f"{scope.replace('five', '5') + ' ' if scope else ''}limit"
    return _signal("window", pools, f"{name} {what}", resetAt=reset_at, retryAfterMs=_wait(error, text))


def classify(provider: str, model: str, error: dict, now: Optional[int] = None) -> Optional[dict]:
    """A failed request as a routing signal ``{kind, pools, evidence, resetAt?, retryAfterMs?}``, or None."""
    now = int(time.time() * 1000) if now is None else now
    etype = error.get("type") or ""
    if etype in _NEVER_ROUTE or etype.startswith("permission.") or etype.startswith("tool."):
        return None
    text = f"{error.get('message') or ''}\n{_body(error)}"
    if any(r.search(text) for r in _IGNORE) and error.get("status") != 429:
        return None
    if etype == "provider.invalid-request" and _CONTEXT_OVERFLOW.search(text):
        return None
    codes = _body_codes(error)
    pools = model_pools(provider, model)
    specific = None
    if provider == "claude-agent":
        specific = _claude_agent(error, text, pools, now)
    elif provider == "anthropic":
        specific = _anthropic(error, text, codes, pools, now)
    elif provider == "xai":
        specific = _xai(error, text, codes, pools)
    elif provider == "github-copilot":
        specific = _copilot(error, text, codes, pools, now)
    elif provider == "openai":
        specific = _openai(error, text, codes, pools, now)
    elif provider == "google":
        specific = _gemini(error, text, provider, model, now)
    elif provider in ("google-vertex", "google-vertex-anthropic"):
        specific = _vertex(error, text, provider, model)
    elif provider == "openrouter":
        specific = _openrouter(error, text, model, now)
    elif provider in ("azure", "azure-cognitive-services"):
        specific = _azure(error, text, codes, provider, model)
    elif provider == "amazon-bedrock":
        specific = _bedrock(error, text, model)
    elif provider in ("ollama-cloud", "opencode-go", "opencode"):
        specific = _plan(error, text, {"ollama-cloud": "Ollama Cloud", "opencode-go": "OpenCode Go", "opencode": "OpenCode Zen"}[provider], pools, now)
    if specific:
        return specific
    if etype == "provider.invalid-request":
        return None
    reset_at = parse_reset_text(text, now)
    account = pools
    if provider in _PER_MODEL:
        pools = [f"{provider}:{model}"]
    if etype in ("provider.quota", "provider.chatgpt-limit", "provider.budget-limit", "provider.model-budget-limit", "provider.go-limit", "provider.free-limit"):
        return _signal("billing", account, f"Quota exhausted ({etype})", resetAt=reset_at)
    if etype == "provider.rate-limit":
        return _signal("window" if reset_at else "throttle", pools, "Rate limited", resetAt=reset_at, retryAfterMs=_wait(error, text))
    if etype == "provider.auth":
        return _signal("auth", account, "Authentication failed")
    if etype in ("provider.internal", "provider.transport", "provider.timeout"):
        return _signal("overload", pools, f"Provider unavailable ({etype})", retryAfterMs=error.get("retryAfterMs"))
    status = error.get("status")
    if status == 429:
        return _signal("window" if reset_at else "throttle", pools, "HTTP 429", resetAt=reset_at, retryAfterMs=_wait(error, text))
    if status == 402:
        return _signal("billing", account, "HTTP 402")
    if isinstance(status, int) and status >= 500:
        return _signal("overload", pools, f"HTTP {status}")
    if _search(r"usage limit|quota (?:exceeded|exhausted)|limit reached", text):
        return _signal("window", pools, "Usage limit", resetAt=reset_at)
    return None


# ---------------------------------------------------------------------------------------------------------------------
# Pool health (the parts of src/engine/pools.ts a gateway needs)
# ---------------------------------------------------------------------------------------------------------------------

_COOLDOWN = {"throttle": (60_000, 10 * 60_000), "overload": (2 * 60_000, 10 * 60_000), "window": (15 * 60_000, DAY), "billing": (6 * HOUR, DAY), "auth": (30 * 60_000, 6 * HOUR)}
_SKEW = 60_000


class Pools:
    """Which pools are set aside, until when, and why. Thread-safe; in memory only."""

    def __init__(self, now: Callable[[], int] = lambda: int(time.time() * 1000)):
        self._now = now
        self._lock = threading.Lock()
        self._pools: dict[str, dict] = {}

    def report(self, sig: dict) -> None:
        now = self._now()
        base, cap = _COOLDOWN[sig["kind"]]
        with self._lock:
            for pool in sig["pools"]:
                prev = self._pools.get(pool)
                again = prev is not None and prev["until"] <= now
                backoff = prev["backoff"] + 1 if again else prev["backoff"] if prev else 0
                grown = min(base * 2**backoff, cap)
                if sig.get("resetAt") is not None:
                    until = sig["resetAt"] + _SKEW
                else:
                    until = now + max(sig.get("retryAfterMs") or 0, grown)
                    # A later deadline already known for this pool stands unless the new evidence is an exact time.
                    if prev and prev["until"] > until:
                        until = prev["until"]
                self._pools[pool] = {"until": until, "kind": sig["kind"], "evidence": sig["evidence"], "backoff": backoff}

    def success(self, pools: list[str]) -> None:
        with self._lock:
            for pool in pools:
                self._pools.pop(pool, None)

    def blocked(self, pools: list[str]) -> Optional[dict]:
        """The pool among these that is set aside for longest, or None when all are usable."""
        now = self._now()
        with self._lock:
            hits = [dict(p, pool=k) for k, p in self._pools.items() if k in pools and p["until"] > now]
        return max(hits, key=lambda p: p["until"]) if hits else None

    def snapshot(self) -> dict[str, dict]:
        now = self._now()
        with self._lock:
            return {k: dict(v) for k, v in self._pools.items() if v["until"] > now}


# ---------------------------------------------------------------------------------------------------------------------
# LiteLLM
# ---------------------------------------------------------------------------------------------------------------------

# LiteLLM's provider names, as quota-router (OpenCode) names them.
_PROVIDERS = {
    "anthropic": "anthropic", "openai": "openai", "text-completion-openai": "openai", "xai": "xai", "gemini": "google",
    "vertex_ai": "google-vertex", "vertex_ai_beta": "google-vertex", "bedrock": "amazon-bedrock", "bedrock_converse": "amazon-bedrock",
    "azure": "azure", "azure_text": "azure", "azure_ai": "azure-cognitive-services", "openrouter": "openrouter",
    "github_copilot": "github-copilot",
}

# LiteLLM's exception classes, as OpenCode's error types.
_ERROR_TYPES = {
    "RateLimitError": "provider.rate-limit", "AuthenticationError": "provider.auth", "PermissionDeniedError": "provider.auth",
    "ContextWindowExceededError": "provider.invalid-request", "BadRequestError": "provider.invalid-request",
    "UnprocessableEntityError": "provider.invalid-request", "NotFoundError": "provider.invalid-request",
    "ContentPolicyViolationError": "provider.content-filter", "ServiceUnavailableError": "provider.internal",
    "InternalServerError": "provider.internal", "APIConnectionError": "provider.transport", "Timeout": "provider.timeout",
    "BudgetExceededError": "provider.quota",
}


def _headers(exc: BaseException) -> dict[str, str]:
    """Response headers from a LiteLLM exception, wherever this version keeps them, with lower-case names."""
    out: dict[str, str] = {}
    for source in (getattr(exc, "litellm_response_headers", None), getattr(getattr(exc, "response", None), "headers", None), getattr(exc, "headers", None)):
        try:
            for k, v in dict(source or {}).items():
                out.setdefault(str(k).lower(), str(v))
        except (TypeError, ValueError):
            continue
    return out


def error_from_exception(exc: BaseException, now: Optional[int] = None) -> dict:
    """A LiteLLM exception as the error the classifier reads."""
    now = int(time.time() * 1000) if now is None else now
    status = getattr(exc, "status_code", None)
    if not isinstance(status, int):
        status = getattr(getattr(exc, "response", None), "status_code", None)
    body = getattr(exc, "body", None)
    if body is not None and not isinstance(body, str):
        try:
            body = json.dumps(body)
        except (TypeError, ValueError):
            body = str(body)
    if body is None:
        try:
            body = getattr(getattr(exc, "response", None), "text", None)
        except Exception:
            body = None
    headers = _headers(exc)
    wait = None
    if headers.get("retry-after-ms", "").replace(".", "", 1).isdigit():
        wait = math.ceil(float(headers["retry-after-ms"]))
    elif headers.get("retry-after"):
        wait = parse_retry_after(headers["retry-after"], now)
    etype = _ERROR_TYPES.get(type(exc).__name__)
    if etype is None and status == 429:
        etype = "provider.rate-limit"
    return {
        "type": etype or "provider.unknown",
        "message": str(getattr(exc, "message", None) or exc),
        **({"status": status} if isinstance(status, int) else {}),
        **({"response": {"body": body}} if isinstance(body, str) and body else {}),
        **({"retryAfterMs": wait} if wait is not None else {}),
    }


def _deployment_identity(params: dict) -> tuple[str, str, str]:
    """(provider, model, account) for a deployment. The account is a short hash of the endpoint and key, so two keys
    for one provider are two accounts with their own limits; the key itself is never kept."""
    model = str(params.get("model") or "")
    provider = str(params.get("custom_llm_provider") or "")
    if "/" in model and not provider:
        provider, model = model.split("/", 1)
    elif "/" in model and model.split("/", 1)[0] == provider:
        model = model.split("/", 1)[1]
    key = params.get("api_key")
    key = key if isinstance(key, str) else ""
    account = hashlib.sha256(f"{params.get('api_base') or ''}\n{key}".encode()).hexdigest()[:12]
    return _PROVIDERS.get(provider, provider or "unknown"), model, account


class QuotaRouter(_Base):  # type: ignore[misc,valid-type]
    """LiteLLM callback: sets a deployment's pool aside after a limit error and filters it out until it is back."""

    def __init__(self, now: Callable[[], int] = lambda: int(time.time() * 1000), log: Optional[Callable[[str], None]] = None):
        try:
            super().__init__()
        except TypeError:
            pass
        self._now = now
        self.pools = Pools(now)
        self._log = log
        self._deployments: dict[str, tuple[str, str, str]] = {}

    def _scoped(self, ident: tuple[str, str, str]) -> list[str]:
        provider, model, account = ident
        return [f"{account}:{p}" for p in model_pools(provider, model)]

    def _ident(self, request_data: Any) -> Optional[tuple[str, str, str]]:
        data = dict(request_data or {})
        meta = {**dict(data.get("metadata") or {}), **dict(data.get("litellm_metadata") or {})}
        info = dict(data.get("model_info") or meta.get("model_info") or {})
        if info.get("id") in self._deployments:
            return self._deployments[info["id"]]
        params = dict(data.get("litellm_params") or {})
        params.setdefault("model", meta.get("deployment") or data.get("model"))
        for k in ("custom_llm_provider", "api_base", "api_key"):
            params.setdefault(k, data.get(k))
        return _deployment_identity(params) if params.get("model") else None

    async def async_filter_deployments(self, model: str, healthy_deployments: list, messages: Any = None, request_kwargs: Optional[dict] = None, parent_otel_span: Any = None) -> list:
        """Leave out deployments whose pool is set aside. When that would leave none, keep them all: trying a
        limited deployment is better than no deployment, and LiteLLM's own cooldowns still apply."""
        keep = []
        for d in healthy_deployments:
            try:
                ident = _deployment_identity(dict(d.get("litellm_params") or {}))
                did = (d.get("model_info") or {}).get("id")
                if did:
                    self._deployments[did] = ident
                if not self.pools.blocked(self._scoped(ident)):
                    keep.append(d)
            except Exception:  # never let routing fail because of this callback
                keep.append(d)
        return keep or healthy_deployments

    async def async_post_call_failure_deployment_hook(self, request_data: Any, exception: BaseException, call_type: Any = None, fallback_depth: Optional[int] = None) -> None:
        try:
            ident = self._ident(request_data)
            if not ident:
                return
            provider, model, account = ident
            sig = classify(provider, model, error_from_exception(exception, self._now()), self._now())
            if not sig:
                return
            self.pools.report({**sig, "pools": [f"{account}:{p}" for p in sig["pools"]]})
            if self._log:
                self._log(f"quota-router: {provider}/{model} set aside ({sig['kind']}): {sig['evidence']}")
        except Exception:
            return

    async def async_post_call_success_deployment_hook(self, request_data: Any, response: Any, call_type: Any = None) -> Any:
        try:
            ident = self._ident(request_data)
            if ident:
                self.pools.success(self._scoped(ident))
        except Exception:
            pass
        return None


proxy_handler_instance = QuotaRouter()
