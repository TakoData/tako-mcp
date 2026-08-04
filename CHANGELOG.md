# Changelog

## [0.17.0](https://github.com/TakoData/tako-mcp/compare/v0.16.1...v0.17.0) (2026-08-04)


### Features

* **answer:** render the chart, the same way tako_search does ([b98f2cf](https://github.com/TakoData/tako-mcp/commit/b98f2cff18ad560f0d8e1044a2522427697a6976))
* **oauth:** email + password sign-in, and a login page worth showing ([4cefe2c](https://github.com/TakoData/tako-mcp/commit/4cefe2cc994db110b6ef1cacc4dd9cbc03352cf9))
* **search:** make Exa highlights the default web snippet for search and answer ([64c0a4b](https://github.com/TakoData/tako-mcp/commit/64c0a4bdbc443b6d5aa328aeec323cea843ca8ad))
* **widget:** a dev-only lever to bust the host's widget cache ([c6c3800](https://github.com/TakoData/tako-mcp/commit/c6c380052f84b479f74378c4fd0c780c60b1a9c4))
* **widget:** probe whether Claude will run Tako's real chart renderer ([c63bc9c](https://github.com/TakoData/tako-mcp/commit/c63bc9cab61465327f4077500b74dec348b92f47))
* **widget:** proxy the chart assets, and the native card renders ([f9295e6](https://github.com/TakoData/tako-mcp/commit/f9295e61cc8e165358136d87c31158d6f856a795))
* **widget:** render Tako's real interactive card on Claude ([106b1bb](https://github.com/TakoData/tako-mcp/commit/106b1bb324fd082066f4fddad3bd92d419ed774e))
* **widgets:** visualize on Claude, and a way down from a dead iframe ([080b805](https://github.com/TakoData/tako-mcp/commit/080b805c8157e9057c4c13b1d96077d42f558283))


### Bug Fixes

* **guards,docs:** guard the copies that drifted, and stop describing a probe that no longer exists ([50b005e](https://github.com/TakoData/tako-mcp/commit/50b005ef1aa75752f1c90e9e2b68390eae3509b7))
* **oauth:** address review — MFA dead end, victim lockout, and guards that could not fail ([27283f1](https://github.com/TakoData/tako-mcp/commit/27283f12985a794a122decd172b252e65d1e8582))
* **oauth:** send the session cookie under the name the target zone reads ([80fedb9](https://github.com/TakoData/tako-mcp/commit/80fedb949d0300bbe0146a6e5a5f30c393ca9835))
* **oauth:** the login mark was dark ink on a dark host ([8daa0d4](https://github.com/TakoData/tako-mcp/commit/8daa0d481fffd984a193092894cd0ef49d5eb4c2))
* **proxy:** a bad binding must not take OAuth down, and neither route may serve a document ([5750d51](https://github.com/TakoData/tako-mcp/commit/5750d51a353a3ffab666fb38ea6bf794ef17780d))
* **search:** serve the snippet contract on the ADVERTISED schema, not the wire guard ([95b8bb0](https://github.com/TakoData/tako-mcp/commit/95b8bb0916a0f6db63580850ed1e3ffd3fa87511))
* **skills:** the web-traffic skill has been loading with no metadata ([a7dc167](https://github.com/TakoData/tako-mcp/commit/a7dc167970d6b86a187da66321adbfd3607b0564))
* **web_snippet:** the harness defaulted to the smoke run, and claimed a blinding it did not do ([87a9a9c](https://github.com/TakoData/tako-mcp/commit/87a9a9c110bebaf24eafb59f21c6e6bacc2099a3))
* **web_snippet:** the judge truncated the sweep it was judging ([10255b3](https://github.com/TakoData/tako-mcp/commit/10255b35c955ff00273e8ed73bf00a9bef85fa21))
* **web_snippet:** time the whole response, and refuse to clobber a sweep ([ea5cab0](https://github.com/TakoData/tako-mcp/commit/ea5cab0b74905a24b323ad0157ebf2346b681a0d))
* **widget:** address review — handshake race, merge mirror, colour class, docs ([5b71fa9](https://github.com/TakoData/tako-mcp/commit/5b71fa9eb8a7f05997207f4a8a9d89c23e0f3425))
* **widget:** close three findings from reviewing this branch ([93eff7e](https://github.com/TakoData/tako-mcp/commit/93eff7e56c0f8881911d10e22744294015e5019f))
* **widget:** keep staticPrefix, and record what the live run disproved ([ccda1e6](https://github.com/TakoData/tako-mcp/commit/ccda1e6daabbb07fc751a1a231cb621e6597a350))
* **widget:** read the host theme on the MCP Apps path, not just ChatGPT's ([f37fa51](https://github.com/TakoData/tako-mcp/commit/f37fa519349cade7e6a9094addd1547bc55c73ff))
* **widget:** size the embed iframe to the card, not to a fixed 720 ([d3a7919](https://github.com/TakoData/tako-mcp/commit/d3a79194d5ebea125357feb6a61f255531ee51fc))
* **widget:** stop telling users the chart failed when it rendered ([2928f01](https://github.com/TakoData/tako-mcp/commit/2928f0163cd15f2236e3782a04a905e8bc9b884c))
* **widget:** stop the card's rounded corners showing white ([e9a10c9](https://github.com/TakoData/tako-mcp/commit/e9a10c98f6469159abd4275cfdffe4ea23256270))
* **widget:** the empty-url fetch, the one-shot resize listener, and the native card's height ceiling ([3039696](https://github.com/TakoData/tako-mcp/commit/3039696db27aac7265a45a41c9b744d9f0a5e705))
* **widget:** transparent surface and host-matched theme ([1687dcd](https://github.com/TakoData/tako-mcp/commit/1687dcdf048cb194b7e25b29d6cc1b1d5f7a4bf8))
* **widget:** use the host's own surface colour, and don't paint where it works ([c1c8c64](https://github.com/TakoData/tako-mcp/commit/c1c8c64eb1f1c13ded26e26e9cc38f7757352ac5))


### Chores

* regenerate schemas + registry from synced spec ([c14361b](https://github.com/TakoData/tako-mcp/commit/c14361b0fe0e67848b36ebd5d7f8c333b1a7d312))
* sync OpenAPI spec from monorepo ([06d1a3f](https://github.com/TakoData/tako-mcp/commit/06d1a3feb2980882741e126fd7512e1be1b538f3))
* sync OpenAPI spec from TakoData/tako ([00d795f](https://github.com/TakoData/tako-mcp/commit/00d795fea593339072fd192f0777808570cd9bf8))


### Documentation

* **web_snippet:** zero observed joins, and the search latency row nobody read ([f5fd69d](https://github.com/TakoData/tako-mcp/commit/f5fd69d81b6958a67a2c1a875ce8c8911511b19f))


### Styles

* **wrangler:** stop repeating the limiter rationale in every env block ([229f5b4](https://github.com/TakoData/tako-mcp/commit/229f5b4740f01f68aa629928026743f73d1fe57b))


### Refactors

* **widget:** retire the probe, bound the asset rewrite ([f5587d9](https://github.com/TakoData/tako-mcp/commit/f5587d911150a9c695458919cb39fdfd87a8a4f1))

## [0.16.1](https://github.com/TakoData/tako-mcp/compare/v0.16.0...v0.16.1) (2026-08-01)


### Chores

* sync OpenAPI spec from monorepo ([0bef7ed](https://github.com/TakoData/tako-mcp/commit/0bef7ed5854df74140c09f46d5beb4cc50c37003))

## [0.16.0](https://github.com/TakoData/tako-mcp/compare/v0.15.3...v0.16.0) (2026-07-31)


### Features

* **available_data:** entity+metric lookup, a relevance gate, and a pin form that works ([9efc25f](https://github.com/TakoData/tako-mcp/commit/9efc25fd3f6a23d52b6a14e501c965610a2cf7bc))


### Bug Fixes

* **available_data:** an alias must account for the whole query, not part of it ([c25016d](https://github.com/TakoData/tako-mcp/commit/c25016d8d61cf71d37ae8d5ac9223dc54719a729))
* **available_data:** let coverage outrank the gate's name preference ([75c8305](https://github.com/TakoData/tako-mcp/commit/75c8305449860493074736a46a03a5cc252dc006))
* **available_data:** only pin a metric node that passed the confidence test ([8b361cb](https://github.com/TakoData/tako-mcp/commit/8b361cb25583f13f455dcde39ac6b9c765b4998a))
* **available_data:** six review findings, and the guard that missed two ([dc5f8c5](https://github.com/TakoData/tako-mcp/commit/dc5f8c5939102f02d8733946da76e143fc1d9bdb))
* **available_data:** stop calling a zero-card pin definitive, and reposition the tool ([e8d5a15](https://github.com/TakoData/tako-mcp/commit/e8d5a1513a7fe484c56c2313bb2c16d80b441d45))
* **guidance:** a pinned zero is not proof of absence, on every surface ([c4d8769](https://github.com/TakoData/tako-mcp/commit/c4d8769b49b148f0a49cf9fba9c19ab4d501369e))
* **guidance:** scope the anti-retry rule to the data axis, not the whole call ([ee35f9c](https://github.com/TakoData/tako-mcp/commit/ee35f9c7f79c8e63421b19d11aaeb04008746bca))
* **mcp:** never emit structuredContent that violates the published schema ([012a6f2](https://github.com/TakoData/tako-mcp/commit/012a6f22397e78db2fd11405b4164dfde3327478))
* **panel:** read .env, stream the trace, and check next_call adherence ([8bb9049](https://github.com/TakoData/tako-mcp/commit/8bb90494a280ad4247b8e74a81730dc0af13b743))
* **review:** close the four surfaces this PR left contradicting itself ([2669eec](https://github.com/TakoData/tako-mcp/commit/2669eec69b9cd7cfc05579ffbd7b280e754858ba))
* **review:** honest source verdicts, one rule on both match paths, guarded skills ([2797e44](https://github.com/TakoData/tako-mcp/commit/2797e44446eb95b13d01935cf986023cad5656e9))
* **routing:** every pin instruction names the form that actually works ([258f535](https://github.com/TakoData/tako-mcp/commit/258f5359164a0a970ff5bf9c631d261ba158e695))
* **routing:** make the instructions agree with the tool descriptions ([825461b](https://github.com/TakoData/tako-mcp/commit/825461b4fe1a0ed7a82143a0c461416cc1a9b894))
* **routing:** name both of available_data's jobs, not just the lookup ([9923530](https://github.com/TakoData/tako-mcp/commit/99235309e7a166ec54b0a119edf42640f39fdd51))
* **search:** route the as-of tier through comparableEpoch too ([1e50ef7](https://github.com/TakoData/tako-mcp/commit/1e50ef78838dd3fe2a14f0e2dae549fb12d6be07))


### Documentation

* **available_data:** stop calling confidentMatch 'token containment' ([2b454ba](https://github.com/TakoData/tako-mcp/commit/2b454ba9dbec552139c8cf40ea15793c9228f079))


### Refactors

* **instructions:** cut per-tool mechanics from the server-level surface ([b01fb99](https://github.com/TakoData/tako-mcp/commit/b01fb995966ab17f696c212bf5f0d7f31208708d))
* **mcp:** remove duplication and mislabelled output found in review ([dd2fd0d](https://github.com/TakoData/tako-mcp/commit/dd2fd0d215818a17e54ef60c9206895774f54bf4))
* **routing:** cut the instructions to routing only, measured vs Exa ([22b5931](https://github.com/TakoData/tako-mcp/commit/22b59314ed0dcc193ed138f78a8aa54484a25507))

## [0.15.3](https://github.com/TakoData/tako-mcp/compare/v0.15.2...v0.15.3) (2026-07-31)


### Chores

* sync OpenAPI spec from monorepo ([803a3e5](https://github.com/TakoData/tako-mcp/commit/803a3e5f989fceed8d792a1b75342f09ee35e8f1))

## [0.15.2](https://github.com/TakoData/tako-mcp/compare/v0.15.1...v0.15.2) (2026-07-30)


### Bug Fixes

* **mcp:** answer 405 on GET/DELETE /mcp so Cursor stops tombstoning the transport ([539edc8](https://github.com/TakoData/tako-mcp/commit/539edc8f9c4ed4f282bc8d62f7950f7b64963386))
* **mcp:** answer 405 on GET/DELETE /mcp, and add one-click install deeplinks ([9568fbd](https://github.com/TakoData/tako-mcp/commit/9568fbde11aa3b9613d75763a8f67a9d62abed36))


### Documentation

* add one-click install deeplinks for Cursor and VS Code ([935c692](https://github.com/TakoData/tako-mcp/commit/935c69257466d1791916e6b1eeb1612cd88dafde))
* use Cursor's canonical install-mcp URL, not the /en/ locale form ([cca499e](https://github.com/TakoData/tako-mcp/commit/cca499e595ae6fecc887db66b049ad7f0d5ad31b))

## [0.15.1](https://github.com/TakoData/tako-mcp/compare/v0.15.0...v0.15.1) (2026-07-30)


### Bug Fixes

* **available_data:** raise MAX_COVERAGE_NAMES to match the server's own cap ([68837a2](https://github.com/TakoData/tako-mcp/commit/68837a2a74fbc5706d2a371da9571f2d581637d8))
* **contents:** address PR review — error gate, batch char budget, batching docs ([e91e204](https://github.com/TakoData/tako-mcp/commit/e91e204f1f85998c8d2405a6482a7fb0346aa5e7))
* **contents:** bump BATCH_CHAR_BUDGET to 250k + log when the derived cap bites ([192d337](https://github.com/TakoData/tako-mcp/commit/192d337b5e384f02b701c04ec242b5bc0129c598))
* correct the research skills against live results; batch contents URLs; fix the structuredContent envelope ([7d7ce88](https://github.com/TakoData/tako-mcp/commit/7d7ce88ede8f1653122d41a1ddfbf20bc50018c8))
* **render:** address PR review — stale docs, dead code, rowsPointer bug ([dff2260](https://github.com/TakoData/tako-mcp/commit/dff22604e3b935a8b70a510bae5fb0e3c434ae17))
* **render:** stop duplicating the tako_contents payload across both channels ([e0245a8](https://github.com/TakoData/tako-mcp/commit/e0245a86ee7e837e38ea10e831e55fe571ab41e4))
* **tools:** soften tako_search's overstated "does not deliver values" claim ([6be8ad0](https://github.com/TakoData/tako-mcp/commit/6be8ad08d70e4d4e268ba0473ee3e02f31d9fb54))
* **tools:** stop claiming card rows arrive in the markdown text ([ed3b940](https://github.com/TakoData/tako-mcp/commit/ed3b94093476a60cfb44c689065b0fab29a769b8))


### Chores

* regenerate schemas + registry from synced spec ([3f32ebe](https://github.com/TakoData/tako-mcp/commit/3f32ebea69e0ab4870081f3e9fd3091c5d49c44c))
* **registry:** regenerate for the tako_contents/tako_search description fixes ([f56630e](https://github.com/TakoData/tako-mcp/commit/f56630e0436fdd9c2c16a1e0925e7136839a14e8))
* **registry:** regenerate for the tako_search/tako_answer description fix ([8703062](https://github.com/TakoData/tako-mcp/commit/87030626beccfed0b05e1d019528c1cafe260835))
* sync OpenAPI spec from monorepo ([fbe9c2c](https://github.com/TakoData/tako-mcp/commit/fbe9c2c9897b86ed6549ac0be05434b2f79cb559))
* sync OpenAPI spec from TakoData/tako ([5c12645](https://github.com/TakoData/tako-mcp/commit/5c12645da170a76f66d371b7d071ea992e7717bb))
* untrack the workers/node_modules symlink (merge blocker) ([cfe5e74](https://github.com/TakoData/tako-mcp/commit/cfe5e74179a1d2a947759abfb1579d61704ffbc3))


### Documentation

* **llms-full:** rows ride in structuredContent, not the prose ([04e2160](https://github.com/TakoData/tako-mcp/commit/04e21600688bbbb73976dd4e7aebe346a215b8f5))
* **skills:** cut em-dash overuse in the reframed prose ([48e5830](https://github.com/TakoData/tako-mcp/commit/48e58300d4ca4e57ea5e37f8c579359b5503b133))
* sync remaining stale wording + missing blank lines from review ([2821048](https://github.com/TakoData/tako-mcp/commit/28210485c48ecdd544d967b40e64ec1a09730a90))
* **tools:** correct two comments still describing the pre-inversion envelope ([1ee1396](https://github.com/TakoData/tako-mcp/commit/1ee139616bf91c75a8e044969e2366e037b7afcf))


### Refactors

* **routing:** make tako_answer the entry point, tako_search the specialist ([1bb4be0](https://github.com/TakoData/tako-mcp/commit/1bb4be065e849df651dcf846bbba9b9841cd9055))

## [0.15.0](https://github.com/TakoData/tako-mcp/compare/v0.14.0...v0.15.0) (2026-07-29)


### Features

* **contents:** expose max_chars with a context-sized 100k default ([cedddc5](https://github.com/TakoData/tako-mcp/commit/cedddc552d5d063e4e8af89eacc578ef78757b90))
* **mcp:** ChatGPT OAuth tool discovery — top-level securitySchemes + auth challenges ([bf8ea26](https://github.com/TakoData/tako-mcp/commit/bf8ea26a8f6919d6f6761aee2ce25cf11bb3bce5))
* **mcp:** ChatGPT OAuth tool discovery — top-level securitySchemes + auth challenges ([a46a6d2](https://github.com/TakoData/tako-mcp/commit/a46a6d2cade05236590f44cff90c0cfce971b2a8))
* **mcp:** log tool and transport errors server-side ([350e0cc](https://github.com/TakoData/tako-mcp/commit/350e0cc1a58db70cbc7c23a19fee1c8483adf8e8))
* **mcp:** per-tool securitySchemes metadata + OAuth challenge helpers ([210c40e](https://github.com/TakoData/tako-mcp/commit/210c40ee6f746a340b6f7909a792650c9613d255))
* **mcp:** per-tool securitySchemes metadata + OAuth challenge helpers ([8dd6795](https://github.com/TakoData/tako-mcp/commit/8dd67950547929841b421d966f1c3bcfb6441486))
* **mcp:** wire per-tool securitySchemes + free-tier auth challenges ([5c77fe2](https://github.com/TakoData/tako-mcp/commit/5c77fe2928ead38f7e102b2453e4adacc994af23))
* **search,answer:** raise web snippet_max_chars to 2000 ([a6ccb65](https://github.com/TakoData/tako-mcp/commit/a6ccb6541041795cd65f60cc2d49223fc3483f87))
* **tools:** break the punt-and-retry loop — dense first responses, deterministic verdicts, discovery handles ([5b6c7d5](https://github.com/TakoData/tako-mcp/commit/5b6c7d5df6afbcdfdcc8f0f6a43a75968240c892))
* **tools:** break the punt-and-retry loop — dense first responses, deterministic verdicts, discovery handles ([37b3ace](https://github.com/TakoData/tako-mcp/commit/37b3ace69a54410168cbd30e21aced2c7fe0116c))
* **tools:** extend markdown rendering to available_data, agent runs, contents ([0fe9240](https://github.com/TakoData/tako-mcp/commit/0fe9240b3aa5630e8347d922da258953fb045220))
* **tools:** gated-card values routing, source glossary, minimal contents envelope ([5ea683f](https://github.com/TakoData/tako-mcp/commit/5ea683f8c8fc2e4804f6474f90de4afd4ce99381))
* **tools:** gated-card values routing, source glossary, minimal contents envelope ([1670801](https://github.com/TakoData/tako-mcp/commit/167080174c282368b086ffe600f2c8d2dd9f92d3))
* **tools:** render search/answer results as markdown; slim structuredContent ([80a77b0](https://github.com/TakoData/tako-mcp/commit/80a77b0746297f2cd31987563d4b6d7d18df64f5))


### Bug Fixes

* **mcp:** address PR [#183](https://github.com/TakoData/tako-mcp/issues/183) review — per-connection schemes, fail-closed tier, equality guard ([d7cb2ae](https://github.com/TakoData/tako-mcp/commit/d7cb2ae8682fcf01eab9b8c6de8c4e5d68b2aa47))
* **mcp:** apply code-review findings to the securitySchemes branch ([878d7f1](https://github.com/TakoData/tako-mcp/commit/878d7f14af305554a597a455a8ff1ff00fa5ce21))
* **render:** fence upstream content, render orphaned/dropped card fields, enforce slim-schema conformance ([1fb48e4](https://github.com/TakoData/tako-mcp/commit/1fb48e4f292d56081ed1b3a228c96c47030029b7))
* **tools:** address PR review — honest preview default, term-fair windows, scoped verdicts, gated next_call ([2be208b](https://github.com/TakoData/tako-mcp/commit/2be208bd90c0d86453e8436ad6cc951593514797))
* **tools:** address review notes — shared searchedData helper, honest filter-miss header ([33fd47b](https://github.com/TakoData/tako-mcp/commit/33fd47bdd7c2925d710f54c2956d3937ee941716))
* **tools:** align coverage cap with server count cap + teach the q/coverage_filter split ([1cf5169](https://github.com/TakoData/tako-mcp/commit/1cf5169907bfca9fdae739485f22a0ca816d9426))
* **tools:** dial coverage cap to 200 names / 4 pages on the free first-call tool ([bba0441](https://github.com/TakoData/tako-mcp/commit/bba044127dd5eae91c399f45322b6c26edae7eb4))
* **widget:** probe iframe capability instead of sniffing window.openai ([9714de8](https://github.com/TakoData/tako-mcp/commit/9714de853c95205a413ee76b22820448f60dca2b))
* **widget:** probe iframe capability instead of sniffing window.openai ([c715ad2](https://github.com/TakoData/tako-mcp/commit/c715ad29b104b616ce78ba09264f2717c70d685c))
* **widget:** sequence iframe probe against the image; robustify load detection ([1144e5f](https://github.com/TakoData/tako-mcp/commit/1144e5f63692022ffc8a468d8be7e05c41ad3669))


### Reverts

* **mcp:** move ChatGPT securitySchemes work to its own branch ([df06f63](https://github.com/TakoData/tako-mcp/commit/df06f639a656f639d5bb998202ada6708a47b292))


### Chores

* regen registry after merging main — lhm.plugin.json picks up the new tool params ([70209f9](https://github.com/TakoData/tako-mcp/commit/70209f98c4de4d5c2d3e63f0b3a2c3ebc311ab18))


### Documentation

* **llms-full:** glossary paragraphs live in the markdown Source Notes section ([204ddf0](https://github.com/TakoData/tako-mcp/commit/204ddf03d7a7b41aff8a44633cb05a76649bea3a))
* **mcp:** align tier/surface docs and guard errors with actual behavior (PR [#183](https://github.com/TakoData/tako-mcp/issues/183) round 2) ([49bdf51](https://github.com/TakoData/tako-mcp/commit/49bdf51344812f2fc5fbc3baa41de119b92a2401))
* sync llms-full.txt + registry with the new tool params ([95844fb](https://github.com/TakoData/tako-mcp/commit/95844fb0ee3bd429a37e0958971aa6339fe05440))

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
