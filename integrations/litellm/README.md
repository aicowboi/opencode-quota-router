# quota-router for LiteLLM

A LiteLLM callback that routes around provider limits. When a deployment fails, it works out what ran out, the same way the OpenCode plugin does: a short rate limit, a plan window with a known reset time, a spent balance, or an outage. It then sets that deployment's pool aside until it's expected back. While it's set aside, the Router uses the model group's other deployments instead of trying it again.

One file, `quota_router.py`, with no dependencies beyond LiteLLM and Python 3.9 or later. Nothing is sent anywhere and nothing is written to disk.

## Install

Copy `quota_router.py` next to your proxy's `config.yaml` (or anywhere on `PYTHONPATH`), then:

**LiteLLM Proxy**

```yaml
litellm_settings:
  callbacks: quota_router.proxy_handler_instance
```

**Python SDK**

```python
import litellm
import quota_router

litellm.callbacks = [quota_router.QuotaRouter()]
router = litellm.Router(model_list=[...])
```

It needs at least two deployments for a model group to have somewhere to go: two keys for the same provider, or the same model on another provider.

## What it does

- **After each failed attempt** (`async_post_call_failure_deployment_hook`, once per deployment attempt, retries and fallbacks included), the error is classified. Anything a different deployment wouldn't fix (a prompt that's too long, a content filter) sets nothing aside.
- **Before each pick** (`async_filter_deployments`), deployments whose pool is set aside are left out. If that would leave none, all are kept: trying a limited deployment beats having none, and LiteLLM's own cooldowns still apply.
- **After a success**, the deployment's pool is clear again.

A pool is what actually runs out. Each API key is its own account, and Gemini, Vertex AI, Bedrock, Azure and OpenRouter limit each model on its own, so one model's limit doesn't set the others aside. Keys are never stored; an account is known by a short hash of its endpoint and key.

How long a pool stays aside: until the reset time the provider gives (plus a minute), or the `retry-after` it sends. Otherwise a cooldown that doubles each time the pool fails again: 1 minute for a rate limit (up to 10), 2 minutes for an outage (up to 10), 15 minutes for a plan window (up to a day), 6 hours for a spent balance.

Recognised: Anthropic, OpenAI and ChatGPT, xAI, Gemini, Vertex AI, OpenRouter (including the free-model allowance), Azure OpenAI and Azure AI, Amazon Bedrock, GitHub Copilot, and any provider's HTTP 429, 402 and 5xx.

## Seeing what it set aside

```python
handler = quota_router.proxy_handler_instance
handler.pools.snapshot()   # {"<account>:anthropic": {"until": ..., "kind": "throttle", "evidence": "Rate limited", ...}}
```

Pass `log=print` (or a logger's method) to `QuotaRouter(...)` to get a line each time a deployment is set aside.

## Tests

```sh
python3 -m unittest discover -s integrations/litellm
```

The classifier is a port of the plugin's (`src/engine/classify.ts`) and is checked against the same invented cases (`test/fixtures/classify.json`), so the two stay in step. It has also been run in a real LiteLLM 1.108 Router: with LiteLLM's own cooldowns turned off, a rate-limited key failed once and then got no more requests.
