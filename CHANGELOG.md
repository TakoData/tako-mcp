# Changelog

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
