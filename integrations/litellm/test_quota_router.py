"""Tests for the LiteLLM callback. Run: python3 -m unittest discover -s integrations/litellm

The classifier is checked against the invented cases the TypeScript plugin uses (test/fixtures/classify.json), so the
two stay in step. LiteLLM itself is not needed: the hooks are called the way LiteLLM calls them.
"""

import asyncio
import json
import os
import pathlib
import sys
import unittest
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import quota_router as qr  # noqa: E402

FIXTURES = pathlib.Path(__file__).resolve().parents[2] / "test" / "fixtures" / "classify.json"
iso = lambda ms: datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat().replace("+00:00", "Z")  # noqa: E731
ms = lambda s: int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)  # noqa: E731


class ClassifierFixtures(unittest.TestCase):
    def test_shared_cases(self):
        data = json.loads(FIXTURES.read_text())
        now = ms(data["now"])
        self.assertGreaterEqual(len(data["cases"]), 25)
        for c in data["cases"]:
            with self.subTest(c["name"]):
                s = qr.classify(c["provider"], c["model"], c["error"], now)
                if c["expect"] is None:
                    self.assertIsNone(s)
                    continue
                self.assertIsNotNone(s)
                self.assertEqual(s["kind"], c["expect"]["kind"])
                self.assertEqual(s["pools"], c["expect"]["pools"])
                if c["expect"].get("evidence"):
                    self.assertEqual(s["evidence"], c["expect"]["evidence"])
                if "resetAt" in c["expect"]:
                    self.assertEqual(s.get("resetAt"), ms(c["expect"]["resetAt"]))
                if "retryAfterMs" in c["expect"]:
                    self.assertEqual(s.get("retryAfterMs"), c["expect"]["retryAfterMs"])

    def test_resets(self):
        la = "America/Los_Angeles"
        nxt = lambda s: iso(qr.next_midnight_in(la, ms(s)))  # noqa: E731
        self.assertEqual(nxt("2026-11-09T19:00:00Z"), "2026-11-10T08:00:00Z")
        self.assertEqual(nxt("2026-07-01T06:59:59Z"), "2026-07-01T07:00:00Z")
        self.assertEqual(nxt("2026-07-01T07:00:00Z"), "2026-07-02T07:00:00Z")
        self.assertEqual(nxt("2026-03-08T08:30:00Z"), "2026-03-09T07:00:00Z")
        self.assertEqual(nxt("2026-11-01T07:30:00Z"), "2026-11-02T08:00:00Z")
        self.assertEqual(qr.parse_retry_text("Please retry after 26 seconds."), 26_000)
        self.assertEqual(qr.parse_retry_text("Please retry in 34.07s"), 34_070)
        self.assertEqual(qr.parse_retry_text("try again in 6m0s"), 360_000)
        self.assertEqual(qr.parse_retry_text("Try again in 250ms"), 250)
        self.assertEqual(qr.parse_retry_text("wait for 2 minutes"), 120_000)
        self.assertIsNone(qr.parse_retry_text("try again later"))
        now = ms("2026-11-09T19:00:00Z")
        self.assertEqual(qr.next_month_utc(now), ms("2026-12-01T00:00:00Z"))
        self.assertEqual(qr.parse_timestamp(ms("2026-11-09T20:00:00Z") // 1000, now), ms("2026-11-09T20:00:00Z"))
        self.assertIsNone(qr.parse_timestamp(1, now))
        self.assertEqual(qr.parse_reset_text("Resets at 2026-11-09T21:00:00.000Z.", now), ms("2026-11-09T21:00:00Z"))
        self.assertEqual(qr.parse_reset_text("You will regain access on 2026-12-01 at 00:00 UTC", now), ms("2026-12-01T00:00:00Z"))
        self.assertEqual(qr.parse_retry_after("30", now), 30_000)
        self.assertEqual(qr.parse_retry_after("Mon, 09 Nov 2026 19:01:00 GMT", now), 60_000)


class FakeRateLimit(Exception):
    def __init__(self, message, status=429, headers=None, body=None):
        super().__init__(message)
        self.message = message
        self.status_code = status
        self.litellm_response_headers = headers or {}
        self.body = body


FakeRateLimit.__name__ = "RateLimitError"


class Hooks(unittest.TestCase):
    def setUp(self):
        self.t = ms("2026-11-09T19:00:00Z")
        self.cb = qr.QuotaRouter(now=lambda: self.t)
        self.deployments = [
            {"model_name": "opus", "litellm_params": {"model": "anthropic/claude-opus-5-5", "api_key": "invented-key-one"}, "model_info": {"id": "d1"}},
            {"model_name": "opus", "litellm_params": {"model": "anthropic/claude-opus-5-5", "api_key": "invented-key-two"}, "model_info": {"id": "d2"}},
            {"model_name": "opus", "litellm_params": {"model": "bedrock/anthropic.claude-opus-5-5", "aws_region_name": "us-east-1"}, "model_info": {"id": "d3"}},
        ]

    def filter(self):
        return [d["model_info"]["id"] for d in asyncio.run(self.cb.async_filter_deployments("opus", list(self.deployments), [], {}))]

    def failed(self, did, exc):
        asyncio.run(self.cb.async_post_call_failure_deployment_hook({"model": "claude-opus-5-5", "model_info": {"id": did}}, exc, "acompletion"))

    def test_a_limited_key_is_left_out_until_its_reset_and_another_key_is_not(self):
        self.assertEqual(self.filter(), ["d1", "d2", "d3"])
        body = json.dumps({"type": "error", "error": {"type": "billing_error", "message": "You will regain access on 2026-12-01 at 00:00 UTC"}})
        self.failed("d1", FakeRateLimit("You will regain access on 2026-12-01 at 00:00 UTC", status=400, body=body))
        self.assertEqual(self.filter(), ["d2", "d3"])
        snap = self.cb.pools.snapshot()
        self.assertEqual(len(snap), 1)
        (pool, state), = snap.items()
        self.assertTrue(pool.endswith(":anthropic"))
        self.assertNotIn("invented-key-one", pool)
        self.assertEqual(state["kind"], "billing")
        self.assertEqual(state["until"], ms("2026-12-01T00:00:00Z") + 60_000)
        self.t = ms("2026-12-01T00:01:01Z")
        self.assertEqual(self.filter(), ["d1", "d2", "d3"])

    def test_a_short_throttle_uses_the_retry_after_header_and_success_clears_it(self):
        self.filter()
        self.failed("d2", FakeRateLimit("Too many requests", headers={"Retry-After": "90"}))
        self.assertEqual(self.filter(), ["d1", "d3"])
        self.assertEqual(next(iter(self.cb.pools.snapshot().values()))["until"], self.t + 90_000)
        asyncio.run(self.cb.async_post_call_success_deployment_hook({"model_info": {"id": "d2"}}, None, "acompletion"))
        self.assertEqual(self.filter(), ["d1", "d2", "d3"])

    def test_when_every_deployment_is_limited_all_are_kept(self):
        self.filter()
        for did in ("d1", "d2", "d3"):
            self.failed(did, FakeRateLimit("ThrottlingException: too many requests"))
        self.assertEqual(self.filter(), ["d1", "d2", "d3"])

    def test_errors_that_another_model_would_not_fix_set_nothing_aside(self):
        self.filter()
        exc = FakeRateLimit("prompt is too long: 250000 tokens > 200000 maximum", status=400)
        exc.__class__ = type("ContextWindowExceededError", (FakeRateLimit,), {})
        self.failed("d1", exc)
        self.assertEqual(self.cb.pools.snapshot(), {})

    def test_a_deployment_not_seen_by_the_filter_is_found_from_the_request(self):
        asyncio.run(self.cb.async_post_call_failure_deployment_hook({"model": "gemini/gemini-3-pro", "api_key": "invented"}, FakeRateLimit("Quota exceeded for metric: generate_content_free_tier_requests, quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier"), "acompletion"))
        (pool, state), = self.cb.pools.snapshot().items()
        self.assertTrue(pool.endswith(":google:gemini-3-pro"))
        self.assertEqual(state["kind"], "window")

    def test_a_broken_request_never_raises(self):
        asyncio.run(self.cb.async_post_call_failure_deployment_hook(None, Exception("x"), None))
        self.assertEqual(asyncio.run(self.cb.async_filter_deployments("m", [{"litellm_params": None}], None)), [{"litellm_params": None}])

    def test_the_proxy_instance_is_ready(self):
        self.assertIsInstance(qr.proxy_handler_instance, qr.QuotaRouter)


if __name__ == "__main__":
    os.environ.setdefault("TZ", "UTC")
    unittest.main()
