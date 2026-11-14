# dsh-canvas 许可与署名声明

Copyright (c) 2026 dsh-canvas contributors.

本项目采用 [非商业使用与署名许可协议](LICENSE)。商业使用不在授权
范围内；本声明是许可摘要，完整条件以 LICENSE 为准。

本软件来源于 dsh-canvas，必须保留指定署名：

[Model Link](https://api.modellink.online)

复制、分发和公开提供修改版本时，请保留 LICENSE、版权声明和本文件。
在 README 或分发说明中保留上述超链接；有用户界面的部署或修改
版本，还须在用户可访问的关于、设置、致谢页面或页脚显示该链接。
修改版本应说明修改情况，不能暗示原作者或 Model Link 为其背书。

Markdown 署名写法：

```markdown
[Model Link](https://api.modellink.online)
```

HTML 署名写法：

```html
<a href="https://api.modellink.online">Model Link</a>
```

第三方依赖和明确附有其他许可证的文件继续遵循各自许可证，
包括仓库中的第三方组件及开发技能。指定署名不要求使用 Model Link
服务，不代表本项目取得第三方商标或内容的所有权。

## 通用创作方法参考

媒体加载使用 [img-fx](https://github.com/Jakubantalik/img-fx) v0.6.0，固定提交 `2098279964046e23bad86d9f42f41a3b06dca735`，Copyright (c) 2026 Jakub Antalik，MIT License。上游源码未经修改，编入客户端；完整许可和来源 / 哈希清单随包保留于 `lib/vendor/img-fx/LICENSE` 与 `lib/vendor/img-fx/source.json`。该第三方源码仅适用自身 MIT 许可，不替代本项目整体许可。

协作悬浮入口使用 [voice-ring](https://libraries.dev/voice-ring) 0.1.2，Copyright (c) 2026 Jakub Antalik，MIT License。其许可如下，仅适用于该依赖，不替代本项目整体许可：

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

`src/host/agent/methods.ts` 保留角色与硬边界，专业方法位于 `src/host/agent/skills`。早期制作方法参考以下 MIT 项目的资产前置、连续性与提示词生命周期经验；未整库复制、执行其脚本或安装为用户全局技能，未将其特定模型流程视为通用协议。

- [kangarooking/director-skills](https://github.com/kangarooking/director-skills/tree/301e6e72199f28b8ea82cd48ff06ab9ae49d0ee5)，固定版本 `301e6e72199f28b8ea82cd48ff06ab9ae49d0ee5`，Copyright (c) 2026 kangarooking。
- [aitippro/tipai-cinema-skills](https://github.com/aitippro/tipai-cinema-skills/tree/f6beda2e7e91bcb7d3073072f70c016a551e3400)，固定版本 `f6beda2e7e91bcb7d3073072f70c016a551e3400`，Copyright (c) 2026 TipAi。

0.2.145的分镜、编剧、音频与审查方法参考 [worldwonderer / ClawHub](https://clawhub.ai/worldwonderer) 的 short-drama-develop / write / storyboard / video-prompts / review、story-long-analyze 及配套方法文档（ClawHub页面标记MIT-0），与 [vargHQ / video-sound](https://clawhub.ai/vargai/video-sound)（原Skill声明MIT）。公开来源、核对日期、内容哈希与采用范围保留在 `docs/agent-skill-content-sources.json`；工作方法按当前角色/接口独立整理，未引入原外部工具、生成器、脚本、自动混音或其默认静音策略。上述第三方来源不为本项目背书。

0.2.146的视觉资产设计、一致性和生图规格参考 [worldwonderer / short-drama-assets](https://clawhub.ai/worldwonderer/short-drama-assets)、[short-drama-image-prompts](https://clawhub.ai/worldwonderer/short-drama-image-prompts) 及其身份/变体、连续性锁、地点/视图、图片配方、局部修订和参考板文档。两份Skill正文声明MIT，ClawHub页面标记MIT-0；两种记录及原内容哈希均保留在来源身份记录中，参考内容按正文MIT保留署名和以下许可。方法与教学例子按本项目独立整理，未复制其脚本、供应商适配、目录/编号体系或自动生成流程。原作者及第三方来源不为本项目背书。

0.2.147的主Agent统筹、方案交接、精确执行清单和音色选择方法参考 [arminnaimi / agent-team-orchestration](https://clawhub.ai/arminnaimi/agent-team-orchestration) 的依赖、任务交接与阻塞方法（已核验页面标记MIT-0），及 [worldwonderer / short-drama-produce](https://clawhub.ai/worldwonderer/short-drama-produce) 的输入预览/原回执核对与 short-drama-assets 的声音方向文档（正文套件MIT，页面标记MIT-0）。来源哈希与采用范围同样保留在身份记录；正文、工作表及例子按本项目独立整理。未引入原状态机、共享路径覆盖、自动重派、adapter、付费生成、重复确认或音频判断流程；对应MIT内容沿用以下许可，第三方来源不为本项目背书。

0.2.149共享四项方法参考 worldwonderer 的 story-long-analyze 与 stage2-extraction（事件因果、原文与旧成果区分）、short-drama-image-prompts 配套文档（参考控制、静态目标与局部修订）、short-drama-video-prompts 配套文档（动作/摄影/声画连续性），并参考上述 agent-team-orchestration / short-drama-produce 和 [aviclaw / verify-before-done-avi](https://clawhub.ai/aviclaw/verify-before-done-avi) 的真实证据/缺口交接方法。新增来源页面标记MIT-0，正文未另行声明；已登记的MIT正文继续保留相应许可差异。正文、工作表和例子按本项目现有接口独立整理，不移植原章节行号、共享目录、任务状态机、自动重试/重派、生成器或主级读取原文的例外。来源哈希与采用范围保留在身份记录；源码准备阶段曾按用户要求只做source-only核验，发布另按实际包与安装证据核对，第三方来源不为本项目背书。

MIT参考内容的许可如下，仅适用于其相应内容，不替代本项目整体许可：

0.2.153模型族方法参考 [gpt-img-2 / gpt-image-2-prompt-architect](https://clawhub.ai/gpt-img-2/gpt-image-2-prompt-architect)、[sallyface0 / jimeng-prompter](https://clawhub.ai/sallyface0/jimeng-prompter)、[zhongkedy-del / seedance-2-prompt](https://clawhub.ai/zhongkedy-del/seedance-2-prompt)（正文署名coopeai.com）、[megasu / minimax-h3-studio](https://clawhub.ai/megasu/minimax-h3-studio)及三份提示词文档、[wangminrui2022 / h3-video-editing-prompt](https://clawhub.ai/wangminrui2022/h3-video-editing-prompt)、[gpt-img-2 / wan-3-video-prompt-architect](https://clawhub.ai/gpt-img-2/wan-3-video-prompt-architect)、[vargai / kling-4-prompting](https://clawhub.ai/vargai/kling-4-prompting)。页面标记MIT-0；jimeng、Seedance和Kling正文另声明MIT，保留署名及本节许可。原文/配套文档SHA-256、版本与采用/拒绝范围见来源身份记录。Banana候选minilozio / nano-banana-prompting未声明许可且有禁止文字等错误，只记录评估，不复制内容；Banana方法依据Google官方指南独立编写，GPT再对照OpenAI公开提示指南。新正文、例子和模板为项目独立整理，不移植原脚本、API、固定数值、英文/JSON强制或付费生成流程，第三方不为本插件或当前型号效果背书。

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
