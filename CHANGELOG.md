# Changelog

## [0.9.0](https://github.com/TakoData/tako-mcp/compare/v0.8.3...v0.9.0) (2026-07-18)


### Features

* expose content_format in tako_contents (json_records / json_compact) ([b42e8f7](https://github.com/TakoData/tako-mcp/commit/b42e8f75d9e62bb000137c0e1ad1899d8a76715f))
* **graph:** actionable error messages that guide agents to the fix ([0b8a0e6](https://github.com/TakoData/tako-mcp/commit/0b8a0e6607a2aa8717e0b818a1a2c3291520f0e0))
* pin graph node_ids/strict in tako_answer ([a507ed5](https://github.com/TakoData/tako-mcp/commit/a507ed5a421135fd22dcaa4d9780cf043fa58bf9))
* pin graph node_ids/strict in tako_search and surface card nodes ([a089ae2](https://github.com/TakoData/tako-mcp/commit/a089ae27d3dcb34397f865b53ba20f65d943a8b5))
* shared graph facades + multi-q merge helper ([91e8726](https://github.com/TakoData/tako-mcp/commit/91e8726d415c0484c7a5f5ebbe54d5add355aee6))
* Tako data-graph tools (search/related/node) + node pinning; fix search 'unexpected shape' outage ([46ee65a](https://github.com/TakoData/tako-mcp/commit/46ee65abaf6209482e4bb11eee37b98c3f5634c2))
* tako_graph_node tool ([1ad50ee](https://github.com/TakoData/tako-mcp/commit/1ad50eef048b822510b7ac5d03f5f48c3471e992))
* tako_graph_related tool with multi-q fan-out ([88e0cb6](https://github.com/TakoData/tako-mcp/commit/88e0cb6e4cf05ea75b3b7072be3121978f93412f))
* tako_graph_search tool ([be8538d](https://github.com/TakoData/tako-mcp/commit/be8538de9a9b3754c203a0141beccb9c7f7f8009))


### Bug Fixes

* **config:** point DJANGO_BASE_URL at tako.com (was trytako.com) ([413e06f](https://github.com/TakoData/tako-mcp/commit/413e06fd2559dc5e89e5caa0da3efa7ebb4bafd9))
* **config:** point DJANGO_BASE_URL at tako.com to unblock graph tools (403/WAF) ([8cb964a](https://github.com/TakoData/tako-mcp/commit/8cb964aaaee9b1c117154f9f1ea41c035bcd9b58))
* correct tako_contents row-cap docs (both modes cap at 20; max_rows→2000) ([93a06b8](https://github.com/TakoData/tako-mcp/commit/93a06b804eeba125d98fd495b9baf94d55fa14b6))
* **deps:** patch hono/undici/vite CVEs (CVE-2026-54290, -9697, -6734, -53571) ([7ddd354](https://github.com/TakoData/tako-mcp/commit/7ddd3548156f01829f337ca872a54f09e4d06365))
* **deps:** patch hono/undici/vite CVEs via overrides ([f6c4b60](https://github.com/TakoData/tako-mcp/commit/f6c4b60a1335a4c5d5cc18123bf1f5bc388d1a13))
* expose max_rows in tako_contents (inline mode was silently capped at 20 rows) ([43b7891](https://github.com/TakoData/tako-mcp/commit/43b7891f9c1b8fb094bc621db30ef06f3b0e249d))
* expose max_rows in tako_contents so inline mode isn't capped at 20 rows ([6286989](https://github.com/TakoData/tako-mcp/commit/628698969d2dc5f77dd8e77c348ae2b1920e7bb8))
* **graph:** validate responses via loose facade, not strict generated schema ([84215b0](https://github.com/TakoData/tako-mcp/commit/84215b0c555fdc9ade44df668ead1cd38193b370))
* **graph:** validate responses via loose facade, not strict generated schema (fixes 'unexpected shape' on kind:source) ([db7f716](https://github.com/TakoData/tako-mcp/commit/db7f71653eebde50dd11552ddd865ec58a96a43d))
* regenerate registry/server.json without unrelated tako_contents drift ([3765dc3](https://github.com/TakoData/tako-mcp/commit/3765dc35266466a4ae97e42bf34e6cf73b5bd308))
* **search:** tolerate renamed content_format field to fix prod 'unexpected shape' outage ([344ad81](https://github.com/TakoData/tako-mcp/commit/344ad8161346a7d6689c7e37de9c7a88b5d89118))


### Chores

* regenerate schemas + registry from synced spec ([a694625](https://github.com/TakoData/tako-mcp/commit/a6946251a13759c88797874d04611a4cc86c7833))
* sync OpenAPI spec from monorepo ([7e0aa82](https://github.com/TakoData/tako-mcp/commit/7e0aa826f01adb9f436689be0f13e87c212da1ec))
* sync OpenAPI spec from TakoData/tako ([f493618](https://github.com/TakoData/tako-mcp/commit/f493618179c399ae184ae833ee370a2410f9274c))


### Documentation

* graph API integration design spec ([efbe2fe](https://github.com/TakoData/tako-mcp/commit/efbe2fe8b9525d21c565d4de0d6a6d5d3aaa37c8))
* graph API integration implementation plan ([0ae177d](https://github.com/TakoData/tako-mcp/commit/0ae177d3ffe594dd92a2c1d83d807b419ea19ca9))
* use parse-don't-cast in graph tool plan snippets ([b8dd5be](https://github.com/TakoData/tako-mcp/commit/b8dd5bee2a134b930c7b076fee3393c0c7505a47))


### Refactors

* re-validate tako_graph_search output through facade ([8738eee](https://github.com/TakoData/tako-mcp/commit/8738eee2a7c6c6ced1984c00bc7cad6fcc8484f4))

## [0.8.3](https://github.com/TakoData/tako-mcp/compare/v0.8.2...v0.8.3) (2026-07-14)


### Chores

* regenerate schemas + registry from synced spec ([62cf6ed](https://github.com/TakoData/tako-mcp/commit/62cf6ed29aec201c1d9288ec82aed33e3c433139))
* sync OpenAPI spec from monorepo ([e5c0943](https://github.com/TakoData/tako-mcp/commit/e5c094360c272601adb87bbfd1e88da188c04ff2))
* sync OpenAPI spec from TakoData/tako ([808c779](https://github.com/TakoData/tako-mcp/commit/808c779c450700f61d011836f5b94836cdd6c2a6))

## [0.8.2](https://github.com/TakoData/tako-mcp/compare/v0.8.1...v0.8.2) (2026-07-11)


### Chores

* regenerate schemas + registry from synced spec ([b0bf0fb](https://github.com/TakoData/tako-mcp/commit/b0bf0fb4125e6c1da280c453739d52340dab9b24))
* sync OpenAPI spec from monorepo ([faa7c51](https://github.com/TakoData/tako-mcp/commit/faa7c51f5c08cf1a9d6f16761a1fe3db3a10e074))
* sync OpenAPI spec from monorepo ([#123](https://github.com/TakoData/tako-mcp/issues/123)) ([f5be9c1](https://github.com/TakoData/tako-mcp/commit/f5be9c18b037a627a2d798238687ad8e96197a37))
* sync OpenAPI spec from TakoData/tako ([3ec4e84](https://github.com/TakoData/tako-mcp/commit/3ec4e84df1a4f38f1c7fbd241839a83c9af54a8c))

## [0.8.1](https://github.com/TakoData/tako-mcp/compare/v0.8.0...v0.8.1) (2026-07-10)


### Bug Fixes

* **contents:** track spec rename format -&gt; content_format ([d21b000](https://github.com/TakoData/tako-mcp/commit/d21b000b461280c0f7e8b96a4efc0c4637f558f2))


### Chores

* sync OpenAPI spec from monorepo ([9215de3](https://github.com/TakoData/tako-mcp/commit/9215de339161960a97c09d5d3ef385d4fccff502))
* sync OpenAPI spec from TakoData/tako ([ea99d19](https://github.com/TakoData/tako-mcp/commit/ea99d197271e9d55d591fd80285ba84231521f28))

## [0.8.0](https://github.com/TakoData/tako-mcp/compare/v0.7.4...v0.8.0) (2026-07-09)


### ⚠ BREAKING CHANGES

* tako_agent now calls /v1/agent/answer/runs and its result no longer includes web_results (use the citations field instead).

### Features

* repoint tako_agent to the Answer Agent API; web_results → citations ([#119](https://github.com/TakoData/tako-mcp/issues/119)) ([c8e0f2a](https://github.com/TakoData/tako-mcp/commit/c8e0f2a5b67e614e9aaeba5f9a71a4f8c94644d6))

## [0.7.4](https://github.com/TakoData/tako-mcp/compare/v0.7.3...v0.7.4) (2026-07-08)


### Chores

* regenerate schemas + registry from synced spec ([10795e5](https://github.com/TakoData/tako-mcp/commit/10795e5b21d1578908be7ec68c36e347f7b5ed62))
* sync OpenAPI spec from monorepo ([f28431f](https://github.com/TakoData/tako-mcp/commit/f28431fb4cffc1f7215c8cfc84371806f546a3ae))
* sync OpenAPI spec from TakoData/tako ([daa466c](https://github.com/TakoData/tako-mcp/commit/daa466cf7f2d7d2a183201ca3bb79aacdf0dfa04))

## [0.7.3](https://github.com/TakoData/tako-mcp/compare/v0.7.2...v0.7.3) (2026-07-07)


### Bug Fixes

* **deps:** bump vitest to 3.2.6 (CVE-2026-47429) ([f53315c](https://github.com/TakoData/tako-mcp/commit/f53315c6ed94e2911f7dcc938fbb8a95df493142))
* **deps:** bump vitest to 3.2.6 to patch CVE-2026-47429 ([6642521](https://github.com/TakoData/tako-mcp/commit/6642521aa3ce1cfcb62ef5a9c0e37ee8a4e82ed5))


### Chores

* regenerate schemas + registry from synced spec ([8de2365](https://github.com/TakoData/tako-mcp/commit/8de23658eb91c704871380da8d25b0cf4939e759))
* sync OpenAPI spec from monorepo ([31684b3](https://github.com/TakoData/tako-mcp/commit/31684b3cf30b7456ba0774a79d5630d9e43ed2ce))
* sync OpenAPI spec from TakoData/tako ([3c3ae9e](https://github.com/TakoData/tako-mcp/commit/3c3ae9ebb50b1f9b56c8cd36b2ac9844aec372db))

## [0.7.2](https://github.com/TakoData/tako-mcp/compare/v0.7.1...v0.7.2) (2026-07-03)


### Chores

* regenerate schemas + registry from synced spec ([911293c](https://github.com/TakoData/tako-mcp/commit/911293ca24fe74d9793efb06f7cada7faabfcd4b))
* sync OpenAPI spec from monorepo ([a037307](https://github.com/TakoData/tako-mcp/commit/a0373072db7758dd6e4e2a188f1a07461c040b06))
* sync OpenAPI spec from TakoData/tako ([087c1a9](https://github.com/TakoData/tako-mcp/commit/087c1a90314f84a5aa46283470c2cbb033715352))

## [0.7.1](https://github.com/TakoData/tako-mcp/compare/v0.7.0...v0.7.1) (2026-07-02)


### Chores

* regenerate schemas + registry from synced spec ([b0f39fd](https://github.com/TakoData/tako-mcp/commit/b0f39fd7ae0bb91b2bcf60ce123f45fc60661fa9))
* sync OpenAPI spec from monorepo ([b1a65be](https://github.com/TakoData/tako-mcp/commit/b1a65bee9039b32f96e023d0394daaa9291da323))
* sync OpenAPI spec from monorepo ([#110](https://github.com/TakoData/tako-mcp/issues/110)) ([eec5536](https://github.com/TakoData/tako-mcp/commit/eec55360781927a92e564546eccf5d227b386b33))
* sync OpenAPI spec from TakoData/tako ([f5d699c](https://github.com/TakoData/tako-mcp/commit/f5d699c732d06b5d5cb190105064f0fd3eaa637e))

## [0.7.0](https://github.com/TakoData/tako-mcp/compare/v0.6.1...v0.7.0) (2026-07-01)


### Features

* wire up release-please for automated versioning and releases ([#100](https://github.com/TakoData/tako-mcp/issues/100)) ([3d8ffcb](https://github.com/TakoData/tako-mcp/commit/3d8ffcb73517836e404484a185684c79180fb61a))


### Chores

* regenerate schemas + registry from synced spec ([f234486](https://github.com/TakoData/tako-mcp/commit/f23448602ae9274a1ccb54fdedce079a0ba1d8a3))
* sync OpenAPI spec from monorepo ([bce99be](https://github.com/TakoData/tako-mcp/commit/bce99be35580232350c085a4a59b27e108d554f2))
* sync OpenAPI spec from monorepo ([#104](https://github.com/TakoData/tako-mcp/issues/104)) ([e1d462d](https://github.com/TakoData/tako-mcp/commit/e1d462def9b810e9789ef7dd4845b2e0be14d4a2))
* sync OpenAPI spec from monorepo ([#105](https://github.com/TakoData/tako-mcp/issues/105)) ([32fd775](https://github.com/TakoData/tako-mcp/commit/32fd7759d0845f9c4c34beeb112d3095becfc873))
* sync OpenAPI spec from monorepo ([#107](https://github.com/TakoData/tako-mcp/issues/107)) ([2622538](https://github.com/TakoData/tako-mcp/commit/26225389a22c152715e7aaed3b42f45b24b9ccfb))
* sync OpenAPI spec from monorepo ([#99](https://github.com/TakoData/tako-mcp/issues/99)) ([82a380f](https://github.com/TakoData/tako-mcp/commit/82a380f976ed5b8c14414fbb38a2a8d9affa45f3))
* sync OpenAPI spec from TakoData/tako ([4865f70](https://github.com/TakoData/tako-mcp/commit/4865f70290e3a816b1fc00a0c04a1dd90913a75d))

## [0.6.1](https://github.com/TakoData/tako-mcp/compare/v0.6.0...v0.6.1) (2026-06-30)


### Chores

* sync OpenAPI spec from monorepo ([#104](https://github.com/TakoData/tako-mcp/issues/104)) ([e1d462d](https://github.com/TakoData/tako-mcp/commit/e1d462def9b810e9789ef7dd4845b2e0be14d4a2))

## [0.6.0](https://github.com/TakoData/tako-mcp/compare/v0.5.0...v0.6.0) (2026-06-30)


### Features

* wire up release-please for automated versioning and releases ([#100](https://github.com/TakoData/tako-mcp/issues/100)) ([3d8ffcb](https://github.com/TakoData/tako-mcp/commit/3d8ffcb73517836e404484a185684c79180fb61a))


### Chores

* sync OpenAPI spec from monorepo ([#99](https://github.com/TakoData/tako-mcp/issues/99)) ([82a380f](https://github.com/TakoData/tako-mcp/commit/82a380f976ed5b8c14414fbb38a2a8d9affa45f3))
