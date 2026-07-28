# Changelog

## [0.14.0](https://github.com/TakoData/tako-mcp/compare/v0.13.0...v0.14.0) (2026-07-28)


### Features

* anonymous rate-limited free tier for /mcp ([f76276e](https://github.com/TakoData/tako-mcp/commit/f76276e83bcb92aa479e4a323395014fb4bdf095))
* **free-tier:** add FREE_TIER_API_KEY and rate-limit bindings ([4c27f34](https://github.com/TakoData/tako-mcp/commit/4c27f34b69debf62264b12a3a629f8dc34f3a578))
* **free-tier:** config gate, tools/call metering, per-IP limiter, 429 ([8748957](https://github.com/TakoData/tako-mcp/commit/87489573964cc2da470b0e1ab6385752ed35c476))
* **free-tier:** restrict anonymous connections to the free toolset ([c0cb740](https://github.com/TakoData/tako-mcp/commit/c0cb740e936324b17546c0c375e71891d5a92b1c))
* **free-tier:** serve anonymous /mcp requests rate-limited per IP ([6a68a4d](https://github.com/TakoData/tako-mcp/commit/6a68a4d26b3943decc0ddc695e4b66fc58140f16))
* **mcp:** log SDK-internal -32602 tool-argument rejections ([bdec340](https://github.com/TakoData/tako-mcp/commit/bdec340fbd6e6afda46218a4b2a54157ba12cfe8))
* **mcp:** render charts as inline MCP Apps widgets on Claude clients ([f530361](https://github.com/TakoData/tako-mcp/commit/f5303612c53f03b52529332fca0d6e8640267236))
* **mcp:** render charts as inline MCP Apps widgets on Claude clients ([34a6ba8](https://github.com/TakoData/tako-mcp/commit/34a6ba83c573ef370938dcbb15e775691287dab2))
* **widget:** declare csp resourceDomains for the remote image fallback ([aff03b4](https://github.com/TakoData/tako-mcp/commit/aff03b432785ca5698f19cdb2a1b537aac5f336a))
* **widget:** notify height via MCP Apps ui/notifications/size-changed ([0966f31](https://github.com/TakoData/tako-mcp/commit/0966f313b200a7d89f44b0ad39ff01c24d85fe63))
* **worker:** serve /.well-known/glama.json for Glama remote-listing claim ([a702a3a](https://github.com/TakoData/tako-mcp/commit/a702a3a5a32c47fc8d8aec5dfbde0c560b98d1f3))


### Bug Fixes

* address PR review — annotationsByClient, submission parity check, UA coverage ([fbcf43f](https://github.com/TakoData/tako-mcp/commit/fbcf43ff71ce781c8e2afec752cfe7f2ba360350))
* address review — drop dead undefined-sources branch, add plugin update-path auth note ([847b856](https://github.com/TakoData/tako-mcp/commit/847b8560424474410f56e15a43e5c3929f513f51))
* address round-3 review — canonical write hints, Apps labels for unknown UAs, guard coverage ([1bc66ba](https://github.com/TakoData/tako-mcp/commit/1bc66ba3b3f47014e282ea021f1ff2cb76b181ba))
* align ChatGPT tool annotations for app review ([654965e](https://github.com/TakoData/tako-mcp/commit/654965e04c8014bd9905e9964283ba3b09aaeddd))
* align ChatGPT tool annotations for app review ([cd7433d](https://github.com/TakoData/tako-mcp/commit/cd7433d91e5dd6eac35c447c74675687719a21d1))
* **anonymous-tier:** address review — billing mode is the gate, not auto-reload ([128b9f7](https://github.com/TakoData/tako-mcp/commit/128b9f72060b2c49c61c969e50e34ea45c6bf8db))
* **anonymous-tier:** apply merge-review fix wave to docs and drift test ([2861e14](https://github.com/TakoData/tako-mcp/commit/2861e142cdc797eaa7be8a947267ce6306837773))
* **anonymous-tier:** drop the word free from the body-too-large message ([2cbfccd](https://github.com/TakoData/tako-mcp/commit/2cbfccd7e810dcbdbe7eaa520178ad2bb356dfd5))
* **anonymous-tier:** stop advertising a rate the limiter cannot enforce ([a69c79b](https://github.com/TakoData/tako-mcp/commit/a69c79bd50a2c0d7c40a443fc5a69f7e0cf1deeb))
* **anonymous-tier:** stop advertising an unenforceable rate limit; credits are the bound ([55e4f1c](https://github.com/TakoData/tako-mcp/commit/55e4f1ca261faeab4eba986455c054455a121d81))
* **anonymous-tier:** stop the machine-readable error kinds disclosing internals ([8bff7a8](https://github.com/TakoData/tako-mcp/commit/8bff7a8892a5357e03d6052a5965faa0abd08712))
* **anonymous-tier:** tighten the per-colo bucket from 120 to 60 ([a6747d4](https://github.com/TakoData/tako-mcp/commit/a6747d4d381f097740914c4f7bc57ac9ec5d0127))
* **ci:** include raw-imports.d.ts in the test tsconfig project ([e92fdb3](https://github.com/TakoData/tako-mcp/commit/e92fdb3d90be66eeeac2280bcb3593a712cb6fe4))
* **ci:** include raw-imports.d.ts in the test tsconfig project ([2b8f7c2](https://github.com/TakoData/tako-mcp/commit/2b8f7c2c5262663568f13c5b5f0d8a25ca2ffd43))
* commit missing tako_visualize annotationsByClient override ([675d241](https://github.com/TakoData/tako-mcp/commit/675d241d69e14c6ccc1996c9de975ece507f6e74))
* **free-tier:** address PR review — readable upsell, global ceiling, hardening ([7afc6ea](https://github.com/TakoData/tako-mcp/commit/7afc6eaa24249eb22189cd4104f132155bc0113c))
* **free-tier:** address round-2 review — honest per-colo framing, readable ceiling errors ([c762db0](https://github.com/TakoData/tako-mcp/commit/c762db004e32a14272a63ab2cc27635dc0e9e290))
* **free-tier:** declare rate limiters under ratelimits, not unsafe.bindings ([a132004](https://github.com/TakoData/tako-mcp/commit/a1320047d4144b8b9d93c39dc3010da2aa52bce2))
* **free-tier:** declare rate limiters under ratelimits, not unsafe.bindings ([f3e938c](https://github.com/TakoData/tako-mcp/commit/f3e938cea7d64fbe878af61c16878e9c073191db))
* **free-tier:** reject anonymous JSON-RPC batches; document OAuth-host impact ([adc2738](https://github.com/TakoData/tako-mcp/commit/adc273865d73a482965e181b355767d3097e9768))
* **mcp:** correct frameDomains narrative + assert claude widget CSP in tests ([9f5c664](https://github.com/TakoData/tako-mcp/commit/9f5c66432bda00d9a543646e94eb9c89ff308a18))
* **mcp:** fire zero-result guidance on any zero-card search, tailored by sources ([42c850a](https://github.com/TakoData/tako-mcp/commit/42c850af5aee8c063ab10bffb7d5199d6666a26f))
* **mcp:** keep Claude Code / Agent SDK on the PNG chart path ([9eaa63a](https://github.com/TakoData/tako-mcp/commit/9eaa63a052462e1a5ff87fe8e6c97120c37b5867))
* **plugin:** connect via OAuth discovery — drop CLI-only userConfig header auth ([4451404](https://github.com/TakoData/tako-mcp/commit/44514040561ca04b0681ee9e95d3768b0a21305c))
* **plugin:** stop empty-search retry loops + make the agent tool truly optional ([edbf920](https://github.com/TakoData/tako-mcp/commit/edbf92075c6113350b06204f9c590f9f7080a047))
* **plugin:** stop empty-search retry loops + make the agent tool truly optional ([1a09748](https://github.com/TakoData/tako-mcp/commit/1a09748c2b00028a3df5477b8d41013c15c5982a))
* **registry:** generate lhm.plugin.json, version-bump it via release-please, use role alias for Glama ([364c070](https://github.com/TakoData/tako-mcp/commit/364c070a6dc6898e5a384d959edda12c27dc2483))
* use canonical $id URL for submission schema reference ([8893f4c](https://github.com/TakoData/tako-mcp/commit/8893f4c3551a1ce27d469067a1b8408281e914e8))
* **visualize:** point-level passthrough, stricter configs, exhaustiveness guard, leaner schema ([d29e337](https://github.com/TakoData/tako-mcp/commit/d29e337b6ed7231bc1ff0ec1a8c5429520a35b7f))
* **visualize:** type component config per component_type; clarify component_variant ([d695d9a](https://github.com/TakoData/tako-mcp/commit/d695d9aee226f90f57bd3ba5fa4f61b49c0c1ae2))
* **widget:** emit size-changed from the baked dynamic widget too ([baa1ac3](https://github.com/TakoData/tako-mcp/commit/baa1ac3c4850292fe992d70087badcb64c3eb502))
* **widget:** harden host-message gate, cover 300 KB charts, re-notify baked height ([7b55c01](https://github.com/TakoData/tako-mcp/commit/7b55c011be27ce8800e11558fdc15295c37f61ab))
* **widget:** log image_data_url fetch failures (Claude's primary chart path) ([3810c4b](https://github.com/TakoData/tako-mcp/commit/3810c4b7fecf4e93a56248787957d37c33109fba))
* **widget:** reject spoofed tool-result postMessages from non-host frames ([d46056d](https://github.com/TakoData/tako-mcp/commit/d46056d73cdb623c8d35df3395f63f9cc00e8c2d))


### Reverts

* **anonymous-tier:** restore per-colo 120 and the distinct global kind ([32cd0a4](https://github.com/TakoData/tako-mcp/commit/32cd0a470539576b90b85c1cae107ce4b72c7ffc))
* **registry:** keep eric@trytako.com for the Glama claim ([7062624](https://github.com/TakoData/tako-mcp/commit/70626242a22a6b66483e594cf60d7172e7edea38))
* **worker:** drop the Glama ownership-verification feature ([655777a](https://github.com/TakoData/tako-mcp/commit/655777acbd57e3881bbb889b3adb95adc6c70b17))


### Chores

* ignore the local .worktrees directory ([0a1eed0](https://github.com/TakoData/tako-mcp/commit/0a1eed0627d6ec19bcd1d3ddd9d750eef76526f3))
* sync OpenAPI spec from monorepo ([#177](https://github.com/TakoData/tako-mcp/issues/177)) ([0973de9](https://github.com/TakoData/tako-mcp/commit/0973de95c6673352e704615e793ac08ea5519465))


### Documentation

* add LobeHub badge and lhm.plugin.json manifest ([36cb6ff](https://github.com/TakoData/tako-mcp/commit/36cb6ffcf7d114be901935346371740c6166bfd5))
* align registry descriptions with README reframe (web search + licensed data) ([f0777a3](https://github.com/TakoData/tako-mcp/commit/f0777a38455cea33661610e75b7b7b1fb130bac7))
* align registry descriptions with README reframe (web search + licensed data) ([9bcf763](https://github.com/TakoData/tako-mcp/commit/9bcf763a9b3223d3e245736a6980d454b0772c24))
* **anonymous-tier:** fix the self-contradicting balance instruction ([a398c6e](https://github.com/TakoData/tako-mcp/commit/a398c6e0d929e019dbc11e26fa0fc5ee94b0a229))
* **anonymous-tier:** record measured limiter behaviour and credits as the bound ([229ea9a](https://github.com/TakoData/tako-mcp/commit/229ea9a77f2da2ebe24663acecc14c31f70fde71))
* **anonymous-tier:** stop calling anonymous access a free tier in the README prose ([e1afd49](https://github.com/TakoData/tako-mcp/commit/e1afd49ca1cc6f5c945418cc8279a11fdefac320))
* explain how each client surface enables the opt-in tools ([2deab1d](https://github.com/TakoData/tako-mcp/commit/2deab1dd7bff705ea96027d79dc8187218eae2bc))
* fix inverted unknown-client comment + reconcile dynamic-URI docstrings ([c0689cb](https://github.com/TakoData/tako-mcp/commit/c0689cbaba33b9dad73254583756d812b9912e5c))
* free tier first — no credentials needed to start, auth as the upgrade ([5cd0315](https://github.com/TakoData/tako-mcp/commit/5cd0315feecb7daf001ac6d5b3698bb7165effdd))
* **free-tier:** expand rollout checklist (account setup, backstop limits, staging verify) ([a704b25](https://github.com/TakoData/tako-mcp/commit/a704b25893e58d315016b43d11830527526ee2a3))
* **free-tier:** operator docs for the anonymous free tier ([35936a6](https://github.com/TakoData/tako-mcp/commit/35936a6a7f048bdcbd39acbbacff173c74f356a7))
* quote skill descriptions as YAML folded blocks ([b12e4c6](https://github.com/TakoData/tako-mcp/commit/b12e4c699aaaf64a12afaa9c005bb17b1b4dff3d))
* **readme:** cover PR's full scope — LobeHub listing, Glama verification, typed visualize configs ([3f927d6](https://github.com/TakoData/tako-mcp/commit/3f927d6ea1fda8a072f1dfea31410e6523281aba))
* sweep stale ChatGPT-only-widget narratives after claude gate flip ([92c82ce](https://github.com/TakoData/tako-mcp/commit/92c82cea8c3d13e199a7fe43adb27f5c46e5a2bb))
* **tests:** correct frameDomains narrative in gate docblock ([43eda09](https://github.com/TakoData/tako-mcp/commit/43eda09608b8a7341546a12ae82151534f3562be))

## [0.13.0](https://github.com/TakoData/tako-mcp/compare/v0.12.0...v0.13.0) (2026-07-25)


### Features

* advertise server-level instructions steering search to tako_search ([4f7f649](https://github.com/TakoData/tako-mcp/commit/4f7f6496384f24130e680e102128f492d19e9f5c))
* **oauth:** RFC 8707 resource indicators + audience-bound access tokens ([99fcefb](https://github.com/TakoData/tako-mcp/commit/99fcefbc25a42207840196737f4dfc953e7fb3f4))
* **oauth:** RFC 8707 resource indicators + audience-bound tokens; per-tool securitySchemes ([4e2623a](https://github.com/TakoData/tako-mcp/commit/4e2623ac24e65222a14134617ab5180b1ee48a2b))
* server instructions steering search to tako_search; Claude Desktop connects via Connectors ([f9f0244](https://github.com/TakoData/tako-mcp/commit/f9f0244d42b8ac96e17cff063689633f055d604a))


### Bug Fixes

* **oauth:** address PR review — resource robustness, refresh binding, 403/expiry ([0200a79](https://github.com/TakoData/tako-mcp/commit/0200a79ff71f1afbe84d9c2fbeff6301afb00fcc))
* **tools:** correct openWorldHint per tool; make it a required annotation ([7b12912](https://github.com/TakoData/tako-mcp/commit/7b12912e42683b3f1f4243536fff8d0c032969e5))
* **tools:** keep openWorldHint per MCP spec; require the annotation ([1c2fa5f](https://github.com/TakoData/tako-mcp/commit/1c2fa5f26b76f1a3a2e2c1f21e0159e4e4206b61))


### Chores

* add 25eliu as glama.json maintainer; hyphenate industry-leading ([a8ac054](https://github.com/TakoData/tako-mcp/commit/a8ac054d69f364088989602344872188e215ac63))
* sync OpenAPI spec from monorepo ([#165](https://github.com/TakoData/tako-mcp/issues/165)) ([f8d7907](https://github.com/TakoData/tako-mcp/commit/f8d790702d7df761904d16e61a5a59006e4948f4))
* sync OpenAPI spec from monorepo ([#169](https://github.com/TakoData/tako-mcp/issues/169)) ([8024690](https://github.com/TakoData/tako-mcp/commit/8024690fbbd104bb6d05db6dbc44a8f8292f1a8f))


### Documentation

* Claude Desktop connects via Connectors, not claude_desktop_config.json ([f00a78f](https://github.com/TakoData/tako-mcp/commit/f00a78f63d70961e6da3c8159ff6c54daaba6c6e))
* document server-level MCP instructions in README ([420e66c](https://github.com/TakoData/tako-mcp/commit/420e66c985f09a40ccf50fc56059367d9e8e6c79))
* reframe README intro around web search + licensed data; add 25eliu as glama maintainer ([6051295](https://github.com/TakoData/tako-mcp/commit/6051295822b2d3912f76077c26fe4914aa6bbb13))
* reframe registry description around agent access to web search + authoritative datasets ([49840c6](https://github.com/TakoData/tako-mcp/commit/49840c68227126a4123a6b1d64a92de089b77b79))

## [0.12.0](https://github.com/TakoData/tako-mcp/compare/v0.11.0...v0.12.0) (2026-07-23)


### Features

* Claude Code plugin — hosted MCP server + bundled research skills ([b0b2c81](https://github.com/TakoData/tako-mcp/commit/b0b2c8153dd6841e5738db99af803395a6c1887c))
* Claude Code plugin — hosted MCP server + bundled research skills ([662f00d](https://github.com/TakoData/tako-mcp/commit/662f00d87cda698754bcc929df91edd1204727e1))
* omit plugin version so marketplace auto-syncs every commit ([8aa0f6b](https://github.com/TakoData/tako-mcp/commit/8aa0f6b51960ad4c1167039ba5b3a0178763b4de))
* pin plugin version to release-please ([4b7fee1](https://github.com/TakoData/tako-mcp/commit/4b7fee15d85b7a057e24aec7bf4e39cd930d0f55))


### Bug Fixes

* use userConfig for plugin auth instead of env interpolation ([85f5460](https://github.com/TakoData/tako-mcp/commit/85f54601da357afdc9826de5207b94387023ef22))


### Documentation

* clarify plugin env var and duplicate-server removal ([faef406](https://github.com/TakoData/tako-mcp/commit/faef4060c4b6bc7ae391a56d877e955abf09f44a))
* persist TAKO_API_KEY in shell profile for plugin path ([f824cc0](https://github.com/TakoData/tako-mcp/commit/f824cc0ab2846e2d871946b6f4282061a345b00f))

## [0.11.0](https://github.com/TakoData/tako-mcp/compare/v0.10.0...v0.11.0) (2026-07-23)


### Features

* **mcp:** inline chart images for unknown MCP clients too (widget stays ChatGPT-only) ([72418fd](https://github.com/TakoData/tako-mcp/commit/72418fd91e9681aa020b0d5dc3119c07ac256cca))
* **mcp:** render charts inline as images on Claude and generic MCP clients ([a983a2f](https://github.com/TakoData/tako-mcp/commit/a983a2f8df2dfee7d3f946ed57086934376206b8))
* **mcp:** render charts inline as images on Claude clients ([4588e43](https://github.com/TakoData/tako-mcp/commit/4588e430cf1041d3b9483056103deec8a18e04b2))
* **tools:** add tako_available_data; demote graph primitives ([8985cf4](https://github.com/TakoData/tako-mcp/commit/8985cf4b49975108ef33b02131bf6f43c1f797ca))
* **tools:** add tako_available_data; demote graph primitives ([a24959d](https://github.com/TakoData/tako-mcp/commit/a24959d2e62f5e2dd08ee4563797ba3cf4e482c9))
* **tools:** emit explicit `exportable` flag on search/answer cards ([e7fb4e9](https://github.com/TakoData/tako-mcp/commit/e7fb4e92b8623eab8fd64b939fb6426dcc6394a4))
* **tools:** explicit `exportable` flag + reframe `tako_available_data` descriptions ([eb6131b](https://github.com/TakoData/tako-mcp/commit/eb6131bb884bc713f434bd4f58370ac4d3facc54))
* **tools:** full coverage names in tako_available_data; dedupe from summary ([e391698](https://github.com/TakoData/tako-mcp/commit/e3916986b7bb10115b4c80b33881fd175f531651))
* **tools:** full coverage names in tako_available_data; dedupe from summary ([6d6834d](https://github.com/TakoData/tako-mcp/commit/6d6834d6fc32d8a806db57f06264af449ed9de09))


### Bug Fixes

* **mcp:** keep resources/list answering on non-ChatGPT clients ([237a356](https://github.com/TakoData/tako-mcp/commit/237a3565e71bc1dd430a8bc75369ef3e2d8fc896))
* **mcp:** only splice recognised structured detail into model text ([7df30fb](https://github.com/TakoData/tako-mcp/commit/7df30fb5c211794fd6572400c386f1a6747196f5))
* **mcp:** surface upstream 4xx error bodies (403/401/404/…) to the model ([b3460bf](https://github.com/TakoData/tako-mcp/commit/b3460bf363e2932e210e246867913508f0a90b81))
* **tools:** address PR [#144](https://github.com/TakoData/tako-mcp/issues/144) review — content gate is necessary, not sufficient ([e65696b](https://github.com/TakoData/tako-mcp/commit/e65696b04323da516316896372cbe95490627f77))
* **tools:** gate tako_contents on the card's content attribute ([1334282](https://github.com/TakoData/tako-mcp/commit/13342826a982713be672d3dc05af0ba834d06d2e))
* **tools:** honest coverage semantics + ?tools=graph escape hatch (PR [#148](https://github.com/TakoData/tako-mcp/issues/148) review) ([af406de](https://github.com/TakoData/tako-mcp/commit/af406deec61879d038b53bf6574230e39df30191))
* **tools:** only call tako_contents on cards that carry a content attribute ([967cdbc](https://github.com/TakoData/tako-mcp/commit/967cdbcebcb449bd86797e243042079ae6ada899))
* **tools:** only call tako_contents on cards that carry a content attribute ([dacb52d](https://github.com/TakoData/tako-mcp/commit/dacb52d0cf32a6910fe0485547ef00cd7a3518e4))
* **tools:** preserve _meta error envelope on contents 403/404; align visualize example ([029543f](https://github.com/TakoData/tako-mcp/commit/029543f9d664dde765272022cdec7fc1cdc391f2))


### Chores

* **registry:** regen server.json for tako_available_data description ([148132d](https://github.com/TakoData/tako-mcp/commit/148132d0691216133972b9870a4310ae62ad6496))
* sync OpenAPI spec from monorepo ([#153](https://github.com/TakoData/tako-mcp/issues/153)) ([2d4772f](https://github.com/TakoData/tako-mcp/commit/2d4772fe6765e09187b6880e3f3ece22f6fcb137))


### Documentation

* add Search API evals blog (benchmarks) to README ([d59a12d](https://github.com/TakoData/tako-mcp/commit/d59a12dd0e34e9dabaf726e1a2080ab42e0fc394))
* graph tools as the coverage-verification path; proprietary-data framing ([c41c289](https://github.com/TakoData/tako-mcp/commit/c41c2892fef9a5acbc5c5044293b418e1f556cea))
* **llms:** document the graph tools and their coverage-verification role ([f39096d](https://github.com/TakoData/tako-mcp/commit/f39096d7897c38bbb9c056d2dafd5fa6ecd829b0))
* redesign README in exa-style with agent skills ([5f7f69a](https://github.com/TakoData/tako-mcp/commit/5f7f69a27672483743c0b5afb6c1fac000d5440f))
* reflect inline chart images on non-ChatGPT hosts ([8211141](https://github.com/TakoData/tako-mcp/commit/82111417b074f69bce1c898576c1df2ccea7afec))
* sharpen agent skills per QA review ([013ed6b](https://github.com/TakoData/tako-mcp/commit/013ed6b79dde189d7f1b6149334a62c4d00a0e6e))
* sharpen agent skills per QA review ([86fd0db](https://github.com/TakoData/tako-mcp/commit/86fd0dbeb44516f9bdf6dc4ca1025a5cc3bcd027))
* sharpen search/answer tool wording + harden financial skill per QA ([171e789](https://github.com/TakoData/tako-mcp/commit/171e7895c936a5eb5bab5ced0d0d8e32da31bdd1))
* **skills:** harden financial skill per QA (card selection, estimates vs actuals, cross-currency, sources, empty results) ([ca46995](https://github.com/TakoData/tako-mcp/commit/ca46995fd2072f1e12a4cffd73ae63b38b97de40))
* **tools:** address PR [#143](https://github.com/TakoData/tako-mcp/issues/143) review — dedupe freshness claim, guard llms-full.txt drift ([bf6e751](https://github.com/TakoData/tako-mcp/commit/bf6e751783cdfcb769fd727af99cca0c7fe47fb7))
* **tools:** frame Tako data as proprietary, continuously-updated live data ([8e091e4](https://github.com/TakoData/tako-mcp/commit/8e091e4d42056a6342fc85591048549be1218ec0))
* **tools:** rewrite tool descriptions in the Exa idiom + sync llms docs ([3d5809b](https://github.com/TakoData/tako-mcp/commit/3d5809b7488142cd0c85ad45c969a73115cb6e5f))
* **tools:** steer sources — keep web enabled until graph-confirmed ([e7641ac](https://github.com/TakoData/tako-mcp/commit/e7641ac9ae0ecd806ac3b2bca86c9e61b8e0500e))
* **tools:** teach the graph tools' coverage-verification role ([e44c99f](https://github.com/TakoData/tako-mcp/commit/e44c99f658d13b38a331ee39c438453a9d3ca7a9))


### Refactors

* **tools:** attribute available-data summary to Tako's proprietary data + bidirectional fan-out tip ([2d4d995](https://github.com/TakoData/tako-mcp/commit/2d4d99552c3188926096990d0ce235e0b10ffcb0))
* **tools:** frame data+web as one result with web-contents fallback; prioritize available_data as first step ([b6a1848](https://github.com/TakoData/tako-mcp/commit/b6a1848838735166420ec1876cb429cc9d9ab313))
* **tools:** reframe tako_available_data as proprietary-data discovery + accuracy pre-check ([37e2bc4](https://github.com/TakoData/tako-mcp/commit/37e2bc46de1b12147f4daa41d28afaa1a1815f28))
* **tools:** Tako-proprietary-data attribution in available-data summary + fan-out tip ([9753c5e](https://github.com/TakoData/tako-mcp/commit/9753c5ec23239fb88b7de03991386d773b802bb2))
* **tools:** trust the API's authoritative exportable flag ([e0827d2](https://github.com/TakoData/tako-mcp/commit/e0827d21f8cdbad0f1432b835a0b8ceb5e230ad3))

## [0.10.0](https://github.com/TakoData/tako-mcp/compare/v0.9.0...v0.10.0) (2026-07-20)


### Features

* make the Tako agent an opt-in tool via the tools query parameter ([c5815ac](https://github.com/TakoData/tako-mcp/commit/c5815ac28c8df02189108f308f40f18055793acb))
* **tools:** make Tako agent opt-in via ?tools=agent ([8713944](https://github.com/TakoData/tako-mcp/commit/871394480e4e9abe591fef89a5266197be3a5fc7))
* **tools:** make tako_visualize, tako_graph_node, get_credit_balance opt-in ([5c7ea64](https://github.com/TakoData/tako-mcp/commit/5c7ea64cf29c11064eb813664ed336760b50621f))
* **tools:** make tako_visualize, tako_graph_node, get_credit_balance opt-in ([92d0c73](https://github.com/TakoData/tako-mcp/commit/92d0c73df783a0a9a6c7d27650f0c5cc8002239a))
* **tools:** slim inline data + clarify search vs answer routing ([dbba122](https://github.com/TakoData/tako-mcp/commit/dbba1220218dcccb98cac2aa435ea7e0e48b87ac))
* **tools:** slim inline data for token efficiency + clarify search vs answer ([0e03e91](https://github.com/TakoData/tako-mcp/commit/0e03e91bb7260e9011e116b31ac65c2bcb564cc1))


### Bug Fixes

* **search:** make inline preview cap order-aware; guard CSV path ([8baa624](https://github.com/TakoData/tako-mcp/commit/8baa624001d454a9cad3883ee80ffc56588b5f12))


### Chores

* address PR [#136](https://github.com/TakoData/tako-mcp/issues/136) review comments ([1712b33](https://github.com/TakoData/tako-mcp/commit/1712b33de40bfef64ffda53c82f846c46bbb5ad1))
* sync OpenAPI spec from monorepo ([#140](https://github.com/TakoData/tako-mcp/issues/140)) ([c254a90](https://github.com/TakoData/tako-mcp/commit/c254a9046c2e5f9938233e25f3f7b5fb9ec6839d))


### Documentation

* **agent-card:** align agent.json with answer-vs-search model + add graph skill ([fb11b8e](https://github.com/TakoData/tako-mcp/commit/fb11b8e202e3b5d6c505272969bed2b8dd9d5588))
* **readme:** thorough accuracy pass ([9c20fbe](https://github.com/TakoData/tako-mcp/commit/9c20fbe1c81b36b609e4fc69edd66e76e739a8d0))
* **spec:** correct test-plan to match implementation (index.test.ts) ([4d6e85c](https://github.com/TakoData/tako-mcp/commit/4d6e85cff0b093e2d554d0c50f5d8097d58cd0ee))
* **spec:** opt-in Tako agent via the tools parameter ([96d5d8e](https://github.com/TakoData/tako-mcp/commit/96d5d8e47bca961830cdacad5cf7c944c20468e1))
* **tools:** clarify when to escalate from search to tako_contents ([b85350e](https://github.com/TakoData/tako-mcp/commit/b85350e91d04bcf8b21affa1b7a59a82a863a74b))
* **tools:** differentiate tako_answer vs tako_search routing by output ([a153b42](https://github.com/TakoData/tako-mcp/commit/a153b42e769e49e776acabe99e27214b38aa9140))
* **tools:** make answer-vs-search distinction explicit + tell model to trust tako_answer ([eac9b1f](https://github.com/TakoData/tako-mcp/commit/eac9b1f133f36802bd4186bec5b2e1ac72bacd06))
* **tools:** reference the Answer Agent only when it's an available tool ([de43c37](https://github.com/TakoData/tako-mcp/commit/de43c37d32b5f30ae9be006d4aadf862c0f5ca0c))
* **tools:** reference the Answer Agent only when it's an available tool ([5ac76d3](https://github.com/TakoData/tako-mcp/commit/5ac76d3066824dcf45ca146158fa06c1e38500ef))


### Refactors

* **tools:** tighten tako_search description to cut per-session context ([3031630](https://github.com/TakoData/tako-mcp/commit/3031630e426ea50459d2e93545bd08f8e79368e7))

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
