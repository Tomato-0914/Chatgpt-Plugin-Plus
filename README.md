![chatgpt-plugin](https://socialify.git.ci/ikechan8370/chatgpt-plugin/image?description=1&font=Jost&forks=1&issues=1&language=1&name=1&owner=1&pulls=1&stargazers=1&theme=Light)
<div align=center>

   <img src ="https://img.shields.io/github/issues/ikechan8370/chatgpt-plugin?logo=github"/>
<img src ="https://img.shields.io/github/license/ikechan8370/chatgpt-plugin"/>
<img src ="https://img.shields.io/github/v/tag/ikechan8370/chatgpt-plugin?label=latest%20version&logo=github"/>
<img src ="https://img.shields.io/github/languages/top/ikechan8370/chatgpt-plugin?logo=github"/>
</div>



![26224FE397F1E74104C1C007C1A32DDE](https://user-images.githubusercontent.com/21212372/227718994-4d33da74-6886-41d5-afd0-73986b086df0.gif)




> 插件v3大幅重构中，基本可用，持续完善中。遇到问题请提issue，欢迎PR。
> todo列表：
> - [x] 插件v3重构完成，插件基本功能可用，持续完善中。
> - [ ] RAG知识库
> - [ ] 预设更详细的配置
> - [x] 自定义触发器
> - [ ] 自定义插件
> - [ ] 兼容mcp


## 插件简介

ChatGPT-Plugin 以 Chaite 为内核，将多模型渠道、工具、处理器、触发器、RAG 和管控面板封装成一套适配 Miao-Yunzai / Yunzai-Bot 的插件方案。通过 Chaite 的 API 服务器与可插拔的存储层（默认 SQLite），插件可以在本地完成高并发对话、知识库检索、伪人陪聊以及记忆管理，亦可接入 Chaite Cloud 复用在线渠道与工具。

## 核心特性

- **多渠道与预设体系**：依托 Chaite 的 ChannelsManager 与 ChatPresetManager，支持为不同模型配置流量、负载均衡与个性化 prompt，群友也可在授权后自助切换预设。
- **高级消息适配**：前后文触发方式支持 `@Bot` 与前缀；自动处理引用、图片、语音等多模态输入，并在工具调用或推理阶段通过转发消息回显。
- **群上下文与伪人模式**：可按配置注入指定条数的群聊记录；BYM 伪人模式支持概率触发、关键词命中、预设覆盖及限时撤回，营造更拟人的陪聊体验。
- **记忆与 RAG**：内置 memoryService + vectra 向量索引，提供群记忆、私人记忆与外部知识库（RAGManager）注入能力，支持混合检索与手动管理。
- **可视化与指令双管控**：`#chatgpt管理面板` 一键获取面板 token，Web 端即可操作渠道、工具、触发器；同时保留完整的命令行 CRUD 指令。
- **自动更新与依赖管理**：`#chatgpt更新` / `#chatgpt强制更新` 调用 git 同步仓库并自动更新 chaite 依赖，减少手动维护成本。

## 快速安装

1. **克隆代码**
   ```bash
   cd plugins
   git clone https://github.com/ikechan8370/chatgpt-plugin.git
   ```
2. **安装依赖**（推荐 Node.js ≥ 18 + pnpm ≥ 8）
   ```bash
   cd chatgpt-plugin
   pnpm install
   ```
   本地记忆功能使用宿主环境常见的 `sqlite3` 驱动；`sqlite-vec` 仅用于向量检索增强，作为可选依赖处理。若 `sqlite-vec` 在当前平台不可用，记忆功能仍会保留基础存储、关键词检索与 LIKE 回退。
3. **在 Yunzai 中启用插件**
    - 重启机器人或运行 `node app` 让插件自动加载。
    - 首次启动会在 `plugins/chatgpt-plugin/config/` 下生成 `config.json / config.yaml`。
4. **保持更新**
    - 主人账号发送 `#chatgpt更新` 获取最新版本。
    - `#chatgpt强制更新` 会放弃本地修改后重新拉取，请谨慎使用。

## 配置指引

配置文件默认位于 `plugins/chatgpt-plugin/config/config.json`，也可改写为 YAML。常用字段示例：

```yaml
basic:
  toggleMode: at            # at / prefix
  togglePrefix: "#chat"     # prefix 模式下的触发词
  commandPrefix: "#chatgpt" # 管理指令前缀
llm:
  defaultModel: "gpt-4o-mini"
  defaultChatPresetId: "default"
  enableGroupContext: true
  groupContextLength: 20
bym:
  enable: false
  probability: 0.02
  defaultPreset: "bym_default"
chaite:
  cloudApiKey: ""           # 可选，接入 Chaite Cloud
  host: "0.0.0.0"
  port: 48370
  publicBaseUrl: ""         # 可选，自定义访问地址，如 https://example.com
vision:
  maxImageSize: 10485760    # 单张图片的 Base64 大小上限，bytes
  maxImageDimension: 8000  # 宽高任一边的上限，px，可设为 1–8000
memory:
  group:
    enable: false
    enabledGroups: ["123456"]
  user:
    enable: false
    whitelist: ["123456789"]
```

- **basic**：控制触发方式、调试与命令前缀。
- **llm**：定义默认模型、嵌入模型、群上下文等。`defaultChatPresetId` 需在面板或命令中提前创建。
- **chaite**：`storage` 默认 SQLite。核心配置保存在 `plugins/chatgpt-plugin/data/data.db`，聊天历史和操作日志分别保存在同目录的 `history.db`、`operation_logs.db`；升级时会自动从旧 `data.db` 分批复制数据，并保留旧表作为兼容备份。如接入 Chaite Cloud，请填入 `cloudApiKey` 并开放 `host/port`。`publicBaseUrl` 会作为“自定义地址”单独发送；插件还会列出本机网卡内网地址，并通过 ip.sb / ip.me 尝试获取公网 IPv4 / IPv6。
- **bym**：配置伪人触发概率、关键词映射、撤回与思考内容开关。
- **vision**：图片超过 `maxImageDimension` 时等比例缩小，超过 `maxImageSize` 时继续压缩；两项限制同时生效。检查覆盖当前消息、历史图片、群聊上下文及识图工具，只处理发送副本，缓存保留原图。管理面板的“视觉配置”中也可修改。对于有更低尺寸要求的模型或多图请求，可以将边长上限设为 `2000`。
- **memory**：为群记忆或私人记忆开启检索、模型与提示词，可按需启用 `extensions.simple` 以加载自定义词典。

修改后保存文件，插件会自动热加载；在 Chaite 面板修改配置时也会反向写回本地文件。

## 使用方式

### 基础对话

- `@Bot 你好` 或 `#chat 今天天气如何` 触发默认预设，插件会保持用户 `conversationId` 与 `messageId`，自动续写多轮对话。
- 回复图片/文本可作为上下文输入，模型返回的图片、语音与思考内容会自动转换为 QQ 消息或转发记录。
- `#结束对话` 仅清空自己的会话；`#结束全部对话` 需主人权限。

### 管理命令 & 面板

- `#chatgpt管理面板`：私聊发送一条转发消息，包含自定义地址、内网地址、外网地址三类一次性登录入口；公网、NAT 或反代场景请配置 `chaite.publicBaseUrl`。
- CRUD 命令示例（均支持 `列表 / 添加 / 查看 / 删除`）：
  ```
  #chatgpt渠道列表
  #chatgpt预设添加 角色扮演 {...}
  #chatgpt工具删除 web-search
  #chatgpt处理器查看 markdown
  ```
- `#chatgpt调试模式开关`、`#chatgpt伪人开关` 等指令可快速切换全局开关。

### 伪人（BYM）模式

1. 在配置中启用 `bym.enable` 并指定 `defaultPreset` 或 `presetMap`。
2. 伪人会在命中关键词或达到概率阈值时主动发言，可通过 `presetPrefix` 调整统一人设，`temperature/maxTokens` 控制语气与长度。
3. 支持为不同关键词配置 `recall` 秒数，实现“发完撤回”效果。

### 记忆系统

- **群记忆指令**
  ```
  #群记忆          #仅群聊
  #删除群记忆 1    #主人或群管
  #记忆列表        #主人查看全局开关
  ```
- **私人记忆指令**
  ```
  #记忆 / 我的记忆
  #他的记忆 @xxx   #群聊内查看他人（需其授权）
  #删除记忆 1
  ```
- 记忆抽取依赖配置中的 `memory.group` / `memory.user` 模型与预设，collector 会定期读取群聊历史，必要时可在 `enabledGroups` 中按群号白名单控制。

### 更新与维护

- `#chatgpt更新`：git pull 插件仓库并使用 pnpm/npm 更新 chaite 依赖。
- `#chatgpt强制更新`：在更新前执行 `git checkout .`，用于舍弃本地改动。
- 日志会通过转发消息发送最近 20 条 commit，方便追踪版本变化。


## 赞助

如果觉得本项目好玩或者对你有帮助，愿意的话可以赞助我一口快乐水：

https://afdian.net/a/ikechan8370

## 贡献者

感谢以下贡献者

<a href="https://github.com/ikechan8370/chatgpt-plugin/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=ikechan8370/chatgpt-plugin" />
</a>


![Alt](https://repobeats.axiom.co/api/embed/076d597ede41432208435f233d18cb20052fb90a.svg "Repobeats analytics image")

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=ikechan8370/chatgpt-plugin&type=Date)](https://star-history.com/#ikechan8370/chatgpt-plugin&Date)

<details>
<summary>工具对照表：XxxX 版 → ikechan 版扩展工具（共 296 个，已实现 108 个，测试中 11 个）</summary>

XxxX 版（XxxXTeam/chatgpt-plugin）`src/mcp/tools` 里的全部工具，与本仓库 `extra-tools/` 中实现同样功能的工具对照。

- **工具名称（ikechan 版）**：本仓库里实现了同样功能的工具，括号里是对应的 action；写着“ikechan 内置……”的表示 ikechan 版自带的功能可以替代，不需要单独写工具
- **危险等级**：low = 只读取信息；high = 会替用户发消息、改动内容或写文件；危险 = 管理群 / 账号、执行命令或代码、绕过协议、删除数据（本仓库里这类工具非主人使用时需要主人确认）
- **是否实现**：✅ 为已实现并测试通过，🆕 为新写好、还在测试中，空白为未实现

| 序号 | 工具名称（XxxX 版） | 工具名称（ikechan 版） | 工具详情 | 危险等级 | 是否实现 |
| --- | --- | --- | --- | --- | --- |
| 1 | `get_current_time` | `get_current_time` | 获取当前时间和日期信息。 | low | ✅ |
| 2 | `sleep` |  | 等待指定时间（用于需要延迟的场景） | low |  |
| 3 | `echo` |  | 原样返回输入内容（用于测试或调试） | low |  |
| 4 | `get_environment` | `system_info`（env） | 获取运行环境信息 | low | ✅ |
| 5 | `list_available_tools` | `system_info`（tools） | 列出所有可用的工具 | low | ✅ |
| 6 | `get_tool_info` | `system_info`（tool） | 获取指定工具的详细信息 | low | ✅ |
| 7 | `get_lunar_date` | `get_current_time` | 获取农历日期 | low | ✅ |
| 8 | `get_festival` | `festival` | 获取近期节日/节气信息 | low | ✅ |
| 9 | `format_number` |  | 格式化数字（添加千位分隔符、转中文等） | low |  |
| 10 | `bing_search` | `web_search` | 使用Bing搜索引擎搜索内容（无需API Key） | low | ✅ |
| 11 | `fetch_webpage` | `fetch_webpage` | 获取指定URL的网页内容并转换为Markdown格式 | low | ✅ |
| 12 | `web_search` | `web_search` | 联网搜索网页，返回前几条结果的摘要，并读取前两条结果的网页正文。 | low | ✅ |
| 13 | `search_wiki` | `encyclopedia`（wiki） | 搜索维基百科 | low | ✅ |
| 14 | `search_group_history` | `search_chat_history` | 搜索群聊历史记录中的关键词 | low | ✅ |
| 15 | `translate` |  | 文本翻译 | low |  |
| 16 | `get_weather` | `get_weather` | 获取天气信息。 | low | ✅ |
| 17 | `get_ip_info` | `ip_info` | 查询IP地址信息 | low | ✅ |
| 18 | `search_baike` | `encyclopedia`（baike） | 搜索百度百科 | low | ✅ |
| 19 | `get_hitokoto` |  | 获取一言（随机句子） | low |  |
| 20 | `get_hot_search` | `hot_search` | 获取热搜榜单。 | low | ✅ |
| 21 | `get_douyin_hot` | `hot_search` | 获取抖音热榜 | low | ✅ |
| 22 | `get_history_today` | `daily_news` | 获取历史上的今天 | low | ✅ |
| 23 | `get_joke` |  | 获取随机笑话 | low |  |
| 24 | `get_morning_paper` | `daily_news` | 获取每天60秒读懂世界早报（当天新闻摘要）。 | low | ✅ |
| 25 | `get_short_url` |  | 生成短链接 | low |  |
| 26 | `get_exchange_rate` | `market_price`（rate） | 查询实时汇率（中国银行外汇牌价，几分钟更新一次，含现汇/现钞买入卖出价和中行折算价），可换… | low | ✅ |
| 27 | `get_gold_price` | `market_price`（metal） | 查询黄金、白银实时行情：上海金 Au99.99、Au(T+D)（元/克），伦敦金、纽约金（… | low | ✅ |
| 28 | `get_oil_price` | `market_price`（oil） | 获取今日油价（92/95/98 号汽油、0 号柴油）和下次调价信息 | low | ✅ |
| 29 | `website` | `fetch_webpage` | 访问网页并获取内容（支持动态渲染） | low | ✅ |
| 30 | `fetch_url` | `fetch_webpage` | 简单HTTP请求获取URL内容（不渲染JavaScript）。 | low | ✅ |
| 31 | `get_current_context` | ikechan 内置群聊上下文 | 获取当前会话的上下文信息 | low |  |
| 32 | `get_conversation_context` | ikechan 内置群聊上下文 | 获取当前对话的详细上下文信息 | low |  |
| 33 | `clear_conversation` | #结束对话 命令 | 清除当前对话历史，开始新会话 | low |  |
| 34 | `get_reply_message` | ikechan 内置（引用消息自动带入） | 获取被引用/回复的消息内容。 | low |  |
| 35 | `get_at_members` |  | 获取当前消息中@的成员列表 | low |  |
| 36 | `get_group_context` | `search_chat_history` | 获取群聊上下文信息（仅群聊有效） | low | ✅ |
| 37 | `send_to_master` | `send_message`（to_master） | 发送私聊消息给主人。 | high | ✅ |
| 38 | `get_master_info` |  | 获取主人信息列表 | low |  |
| 39 | `send_private_message` | `send_message`（private） | 发送私聊消息给指定用户。 | high | ✅ |
| 40 | `send_group_message` | `send_message`（group） | 发送群消息 | high | ✅ |
| 41 | `reply_current_message` |  | 回复当前会话消息（自动判断群聊/私聊） | high |  |
| 42 | `at_user` | `at_user` | 发送@用户消息。 | high | ✅ |
| 43 | `at_role` |  | 按角色随机@群成员。 | high |  |
| 44 | `random_at` | `send_message`（random_at） | 随机@群成员。 | high | ✅ |
| 45 | `get_chat_history` | `search_chat_history` | 获取聊天历史记录。 | low | ✅ |
| 46 | `recall_message` | `group_admin`（recall） | 撤回消息（仅限2分钟内的消息） | 危险 | ✅ |
| 47 | `get_forward_msg` | `forward_msg` | 获取合并转发消息的完整内容。 | low | 🆕 |
| 48 | `deep_parse_message` |  | 深度解析消息内容。 | low |  |
| 49 | `send_forward_msg` |  | 【统一】发送合并转发消息。 | high |  |
| 50 | `resend_quoted_card` |  | 【推荐】重新发送引用消息中的卡片。 | high |  |
| 51 | `mark_msg_as_read` |  | 标记消息为已读（NapCat扩展） | high |  |
| 52 | `get_essence_msg_list` | `essence`（list） | 获取群精华消息列表 | low | 🆕 |
| 53 | `set_essence_msg` | `essence`（set） | 设置群精华消息 | 危险 | 🆕 |
| 54 | `delete_essence_msg` | `essence`（remove） | 移除群精华消息 | 危险 | 🆕 |
| 55 | `poke_user` | `poke_user` | 戳一戳用户 | high | ✅ |
| 56 | `set_msg_emoji_like` | `emoji_reaction` | 对消息发送表情回应（表情贴） | high | 🆕 |
| 57 | `get_msg` |  | 获取消息详情。 | low |  |
| 58 | `send_raw_message` |  | 发送原始消息段数组。 | 危险 |  |
| 59 | `send_card` |  | 【统一】发送卡片消息。 | high |  |
| 60 | `send_markdown` |  | 发送Markdown消息（NapCat/TRSS支持） | high |  |
| 61 | `send_button` |  | 发送按钮消息（NapCat扩展） | high |  |
| 62 | `call_api` |  | 直接调用Bot API（NapCat/OneBot扩展）。 | 危险 |  |
| 63 | `send_long_msg` |  | 发送长消息（NapCat扩展）。 | high |  |
| 64 | `get_msg_reactions` |  | 获取消息的表情回应列表（NapCat扩展） | low |  |
| 65 | `send_long_message` |  | 直接发送长消息。 | high |  |
| 66 | `send_protocol_packet` |  | 发送底层协议包。 | 危险 |  |
| 67 | `send_pb_message` |  | 发送 Protobuf/OIDB/Uni/SSO 协议包，等同于 send_protoco… | 危险 |  |
| 68 | `send_forward_direct` |  | 直接发送转发消息 | high |  |
| 69 | `make_forward_msg` |  | 构造转发消息节点。 | high |  |
| 70 | `extract_forward_data` | `forward_msg` | 提取合并转发消息的完整底层数据。 | low | 🆕 |
| 71 | `deserialize_message` |  | 反序列化消息数据。 | low |  |
| 72 | `decode_protobuf` |  | 解码 Protobuf 数据。 | low |  |
| 73 | `get_message_record` |  | 获取消息的完整记录数据（msgrecord）。 | low |  |
| 74 | `get_user_info` | `user_profile` | 获取QQ用户的基本信息，包括昵称、头像、性别等。 | low | ✅ |
| 75 | `get_friend_list` |  | 获取机器人的好友列表 | low |  |
| 76 | `send_like` | `send_like` | 给用户点赞（需要是好友） | high | ✅ |
| 77 | `get_avatar` | `user_profile` | 获取用户或群头像URL | low | ✅ |
| 78 | `get_sender_info` | `member_info` | 获取当前消息发送者的详细信息 | low | ✅ |
| 79 | `search_friend` |  | 在好友列表中搜索用户（按昵称或备注） | low |  |
| 80 | `check_is_friend` |  | 检查指定用户是否是机器人的好友 | low |  |
| 81 | `get_bot_info` |  | 获取机器人自身的信息 | low |  |
| 82 | `get_user_profile` | `user_profile` | 获取用户的详细资料（包括签名、等级等） | low | ✅ |
| 83 | `get_group_info` | `group_info`（info） | 获取群组的基本信息，包括群名、成员数量等。 | low | ✅ |
| 84 | `get_group_list` | `group_info`（list） | 获取机器人加入的群列表 | low | ✅ |
| 85 | `get_group_member_list` | `group_members`（list） | 获取群成员列表 | low | ✅ |
| 86 | `get_group_member_info` | `member_info` | 获取群成员的详细信息 | low | ✅ |
| 87 | `get_current_group` | `group_info`（info） | 获取当前会话所在群的详细信息 | low | ✅ |
| 88 | `get_group_admins` | `group_members`（admins） | 获取群管理员列表（包括群主） | low | ✅ |
| 89 | `search_group_member` | `member_info`（search） | 在群成员中搜索用户（按昵称或群名片） | low | ✅ |
| 90 | `get_group_notice` | `group_info`（notice） | 获取群公告列表 | low | ✅ |
| 91 | `check_in_group` | `group_members`（check） | 检查用户是否在指定群内 | high | ✅ |
| 92 | `search_group` | `group_info`（list） | 在已加入的群列表中搜索群组 | low | ✅ |
| 93 | `get_group_level` | `group_activity`（level） | 获取QQ群星级信息，包括群等级、活跃人数、群排名等。 | low | ✅ |
| 94 | `get_dragon_king` | `group_activity`（honor） | 获取群龙王信息。 | low | ✅ |
| 95 | `get_sign_in_today` | `group_activity`（sign_in） | 获取今日群打卡列表。 | low | ✅ |
| 96 | `get_speak_rank` | `group_activity`（speak_rank） | 获取群发言排行榜。 | low | ✅ |
| 97 | `get_group_data` | `group_activity`（data） | 获取群活跃数据统计，包括消息总数、活跃成员数、新增成员数、退群人数等。 | low | ✅ |
| 98 | `get_lucky_list` | `lucky_word`（list） | 获取群幸运字符列表。 | low | ✅ |
| 99 | `draw_lucky` | `lucky_word`（draw） | 抽取幸运字符。 | high | ✅ |
| 100 | `equip_lucky` | `lucky_word`（equip） | 装备或更换幸运字符。 | high | ✅ |
| 101 | `switch_lucky` | `lucky_word`（switch） | 开启或关闭群幸运字符功能。 | high | ✅ |
| 102 | `get_inactive_members` | `group_members`（inactive） | 获取群内不活跃成员列表。 | low | ✅ |
| 103 | `get_recent_join_members` | `group_members`（recent_join） | 获取最近入群的成员列表。 | low | ✅ |
| 104 | `get_group_honor` | `group_activity`（honor） | 获取群荣誉信息，包括龙王、群聊之火、群聊炽焰、冒尖小春笋、快乐源泉等荣誉称号及获得者。 | low | ✅ |
| 105 | `get_group_stat` | `group_info`（stat） | 获取群成员统计信息，包括成员总数、群主数、管理员数、普通成员数，以及性别分布统计。 | low | ✅ |
| 106 | `get_random_group_member` | `group_members`（random） | 随机抽取群成员，可用于随机点名、抽奖、随机@等场景。 | low | ✅ |
| 107 | `parse_image` | ikechan 内置识图 | 解析消息中的图片，获取图片URL或base64数据 | low |  |
| 108 | `generate_qrcode` |  | 生成二维码图片 | low |  |
| 109 | `get_image_info` |  | 获取图片的基本信息（尺寸、格式等） | low |  |
| 110 | `send_image` | `send_image` | 发送图片消息 | high | ✅ |
| 111 | `send_video` |  | 发送短视频消息 | high |  |
| 112 | `parse_video` |  | 获取消息中的视频信息 | low |  |
| 113 | `send_dice` |  | 发送骰子表情 | high |  |
| 114 | `send_rps` |  | 发送猜拳表情（石头剪刀布） | high |  |
| 115 | `send_music` | `send_music` | 发送音乐分享卡片 | high | ✅ |
| 116 | `send_location` |  | 发送位置分享 | high |  |
| 117 | `send_share` |  | 发送链接分享卡片 | high |  |
| 118 | `send_face` |  | 发送QQ表情 | high |  |
| 119 | `send_mface` |  | 发送商城表情/大表情 | high |  |
| 120 | `send_flash_image` |  | 发送闪照（阅后即焚图片） | high |  |
| 121 | `send_gift` |  | 发送礼物（需要是好友或群友） | high |  |
| 122 | `get_face_list` |  | 获取常用QQ表情ID列表 | low |  |
| 123 | `parse_mface` |  | 解析消息中的商城表情信息 | low |  |
| 124 | `download_image` | `file_download` | 下载图片到插件受管临时目录并返回本地路径；发送后立即清理，未发送时按TTL清理。 | low | ✅ |
| 125 | `save_emoji` |  | 保存一张图片到群表情包库。 | high |  |
| 126 | `send_saved_emoji` |  | 从群表情包库中选择并发送一个表情包。 | high |  |
| 127 | `list_saved_emojis` |  | 列出群表情包库中已保存的表情。 | low |  |
| 128 | `search_music_qq` | `send_music` | 搜索QQ音乐并发送音乐卡片 | high | ✅ |
| 129 | `search_emoji` | `search_image`（emoji） | 搜索表情包并发送 | high | ✅ |
| 130 | `search_image_bing` | `search_image`（any） | 使用Bing搜索图片并发送 | high | ✅ |
| 131 | `set_msg_reaction` | `emoji_reaction` | 对消息添加表情回应（贴表情），可从聊天记录的[消息ID:xxx]获取message_id | high | 🆕 |
| 132 | `search_wallpaper` | `search_image`（wallpaper） | 搜索壁纸图片 | high | ✅ |
| 133 | `bilibili_search` | `bilibili`（search） | 搜索B站视频并发送结果 | high | ✅ |
| 134 | `github_repo_info` |  | 获取GitHub仓库的详细信息 | low |  |
| 135 | `ai_image_edit` |  | 使用AI编辑图片，使用框架配置的图片模型 | high |  |
| 136 | `bilibili_video_summary` |  | 获取B站视频的AI总结，包含视频摘要、大纲和精选弹幕 | low |  |
| 137 | `video_analysis` |  | 分析视频内容，支持从消息中获取视频或提供视频URL，使用智谱AI进行视频理解 | low |  |
| 138 | `ai_mindmap` |  | 生成思维导图，基于描述生成Markmap格式的思维导图并渲染为图片 | low |  |
| 139 | `hitokoto` |  | 获取一条随机的一言（名言、语录、台词等） | low |  |
| 140 | `roll_dice` |  | 掷骰子，支持多种格式如 2d6（投2个6面骰子）、1d20+5（投1个20面骰子加5） | low |  |
| 141 | `random_choose` |  | 从给定的选项中随机选择一个或多个 | low |  |
| 142 | `create_short_url` |  | 将长链接转换为短链接 | low |  |
| 143 | `query_ip_info` |  | 查询IP地址的地理位置和相关信息 | low |  |
| 144 | `get_illustration` |  | 获取动漫插画图片 | low |  |
| 145 | `calculate` |  | 执行数学计算（支持基本运算和函数） | low |  |
| 146 | `random_number` |  | 生成随机数 | low |  |
| 147 | `random_choice` |  | 从列表中随机选择 | low |  |
| 148 | `uuid` |  | 生成 UUID | low |  |
| 149 | `hash` |  | 计算文本的哈希值 | low |  |
| 150 | `url_encode` |  | URL 编码/解码 | low |  |
| 151 | `json_format` |  | 格式化或压缩 JSON | low |  |
| 152 | `timestamp` |  | 时间戳转换 | low |  |
| 153 | `countdown` |  | 计算距离目标时间的倒计时 | low |  |
| 154 | `regex_match` |  | 使用正则表达式匹配文本 | low |  |
| 155 | `regex_replace` |  | 使用正则表达式替换文本 | low |  |
| 156 | `text_stats` |  | 统计文本信息（字数、行数等） | low |  |
| 157 | `text_transform` |  | 文本转换（大小写、繁简体等） | low |  |
| 158 | `extract_urls` |  | 从文本中提取URL链接 | low |  |
| 159 | `extract_emails` |  | 从文本中提取邮箱地址 | low |  |
| 160 | `extract_phones` |  | 从文本中提取手机号码 | low |  |
| 161 | `split_text` |  | 按分隔符分割文本 | low |  |
| 162 | `join_text` |  | 将数组合并为文本 | low |  |
| 163 | `truncate_text` |  | 截断文本到指定长度 | low |  |
| 164 | `escape_html` |  | HTML转义/反转义 | low |  |
| 165 | `generate_password` |  | 生成随机密码 | low |  |
| 166 | `dice_roll` |  | 掷骰子 | low |  |
| 167 | `draw_lots` |  | 抽签/抽奖 | low |  |
| 168 | `get_group_files` | `group_files`（list / search） | 获取群文件列表 | low | ✅ |
| 169 | `get_file_url` | `group_files`（url） | 获取群文件下载链接 | low | ✅ |
| 170 | `upload_group_file` | `file_send` | 上传文件到群（需要文件URL或本地路径） | high | ✅ |
| 171 | `delete_group_file` | `group_files`（delete） | 删除群文件 | 危险 | ✅ |
| 172 | `create_group_folder` | `group_files`（mkdir） | 创建群文件夹 | high | ✅ |
| 173 | `get_group_file_system_info` | `group_files`（info） | 获取群文件系统信息（用量、数量等） | low | ✅ |
| 174 | `get_group_root_files` | `group_files`（list） | 获取群根目录文件列表 | low | ✅ |
| 175 | `get_group_files_by_folder` | `group_files`（list） | 获取群子目录文件列表 | low | ✅ |
| 176 | `move_group_file` | `group_files`（move） | 移动群文件到其他文件夹 | 危险 | ✅ |
| 177 | `rename_group_file` | `group_files`（rename） | 重命名群文件 | 危险 | ✅ |
| 178 | `delete_group_folder` | `group_files`（rmdir） | 删除群文件夹 | 危险 | ✅ |
| 179 | `upload_private_file` | `file_send` | 上传私聊文件 | high | ✅ |
| 180 | `get_private_file_url` |  | 获取私聊文件下载链接 | low |  |
| 181 | `download_file` | `file_download` | 下载文件到插件受管临时目录。 | high | ✅ |
| 182 | `send_file_message` | `file_send` | 发送文件消息（群聊或私聊） | high | ✅ |
| 183 | `get_file` | `file_read` | 获取文件信息（支持私聊和群聊文件） | low | ✅ |
| 184 | `ocr_image` | ikechan 内置识图 | 图片OCR文字识别 | low |  |
| 185 | `can_send_record` |  | 检查是否可以发送语音 | low |  |
| 186 | `can_send_image` |  | 检查是否可以发送图片 | low |  |
| 187 | `read_file` | `file_read` | 读取本地文件内容。 | low | ✅ |
| 188 | `write_file` | `file_write` | 写入内容到本地文件。 | high | ✅ |
| 189 | `list_directory` | `file_list` | 列出目录中的文件和子目录。 | low | ✅ |
| 190 | `download_to_file` | `file_download` | 从URL下载文件到本地指定路径。 | high | ✅ |
| 191 | `download_group_file_to_file` |  | 下载群文件到本地指定目录。 | high |  |
| 192 | `delete_file` |  | 删除本地文件或空目录。 | 危险 |  |
| 193 | `copy_file` |  | 复制本地文件到另一个位置。 | high |  |
| 194 | `move_file` |  | 移动或重命名本地文件。 | 危险 |  |
| 195 | `get_file_info` | `file_list` | 获取本地文件的详细信息，包括大小、创建时间、修改时间等。 | low | ✅ |
| 196 | `create_directory` | `file_write` | 创建本地目录，支持递归创建多级目录。 | high | ✅ |
| 197 | `save_user_memory` | ikechan 内置记忆 | 保存关于用户的重要信息到记忆库。 | high |  |
| 198 | `get_user_memories` | ikechan 内置记忆 | 获取用户的记忆列表。 | low |  |
| 199 | `search_user_memory` | ikechan 内置记忆 | 搜索用户记忆。 | low |  |
| 200 | `delete_user_memory` | ikechan 内置记忆 | 删除指定的用户记忆。 | high |  |
| 201 | `update_user_memory` | ikechan 内置记忆 | 更新已有的记忆内容。 | high |  |
| 202 | `kg_get_knowledge` |  | 获取当前用户/群的知识图谱上下文。 | low |  |
| 203 | `kg_list_entities` |  | 列出知识图谱中指定作用域的实体。 | low |  |
| 204 | `kg_search_entities` |  | 按名称模糊搜索知识图谱实体。 | low |  |
| 205 | `kg_save_entity` |  | 在知识图谱中保存或更新一个实体（人物、物品、地点、概念、事件）。 | high |  |
| 206 | `kg_update_entity` |  | 更新知识图谱中已有实体的属性或类型。 | high |  |
| 207 | `kg_delete_entity` |  | 删除知识图谱中的实体（保留历史可回滚）。 | high |  |
| 208 | `kg_entity_history` |  | 获取知识图谱实体的历史版本记录。 | low |  |
| 209 | `kg_entity_relations` |  | 获取知识图谱中与某实体直接关联的其他实体（关系列表）。 | low |  |
| 210 | `kg_save_relation` |  | 在知识图谱中保存两个实体之间的关系（如"张三 认识 李四"）。 | high |  |
| 211 | `kg_delete_relation` |  | 删除知识图谱中的关系（保留历史可回滚）。 | high |  |
| 212 | `kg_query_subgraph` |  | 以某实体为中心探索知识图谱子图（返回指定深度内的实体与关系）。 | low |  |
| 213 | `kg_stats` |  | 获取知识图谱的作用域统计（实体数、关系数、类型分布）。 | low |  |
| 214 | `set_reminder` | `reminder`（add） | 设置定时提醒。 | high | ✅ |
| 215 | `list_reminders` | `reminder`（list） | 查看当前用户的所有提醒 | low | ✅ |
| 216 | `cancel_reminder` | `reminder`（cancel） | 取消指定的提醒 | low | ✅ |
| 217 | `schedule_task` | `reminder`（add） | 创建定时任务。 | high | ✅ |
| 218 | `cancel_scheduled_task` | `reminder`（cancel） | 取消定时任务 | low | ✅ |
| 219 | `list_my_scheduled_tasks` | `reminder`（list） | 列出我的定时任务 | low | ✅ |
| 220 | `generate_image` |  | 使用内置绘图服务生成图片（文生图/图生图）。 | high |  |
| 221 | `generate_video` |  | 使用内置绘图服务生成视频（文生视频/图生视频）。 | high |  |
| 222 | `list_image_presets` |  | 列出所有可用的绘图预设模板。 | low |  |
| 223 | `use_image_preset` |  | 使用内置绘图预设生成图片。 | high |  |
| 224 | `get_image_gen_status` |  | 获取绘图服务的当前状态，包括是否启用、当前模型、可用API数量、预设统计等 | low |  |
| 225 | `set_ai_voice_chat` |  | 设置群AI声聊开关（需要NapCat协议端）。 | high |  |
| 226 | `get_ai_voice_characters` |  | 【查询】获取AI声聊可用的角色/音色列表。 | low |  |
| 227 | `send_ai_voice` |  | 【发送】AI语音消息到群聊（使用QQ的AI声聊功能合成语音）。 | high |  |
| 228 | `send_voice` |  | 发送语音消息（直接发送语音文件） | high |  |
| 229 | `parse_voice` |  | 获取消息中的语音信息 | low |  |
| 230 | `get_record` |  | 获取语音文件详情（转换格式等） | low |  |
| 231 | `get_tts_speakers` |  | 【查询】获取VITS语音合成可用的角色/音色列表。 | low |  |
| 232 | `send_tts` |  | 发送TTS语音消息（使用 VITS 语音合成，支持多种角色和语言） | high |  |
| 233 | `get_ai_record` |  | 【获取数据】仅获取AI语音的文件数据，不会发送消息。 | low |  |
| 234 | `send_private_ai_record` |  | 发送私聊AI语音消息。 | high |  |
| 235 | `get_voice_info` |  | 获取语音消息的详细信息（包括下载URL） | low |  |
| 236 | `download_voice` |  | 下载语音文件 | low |  |
| 237 | `voice_to_text` |  | 语音转文字（语音识别） | low |  |
| 238 | `get_ai_voice_status` |  | 【查询】群AI声聊功能是否可用（仅查询状态，不发送消息）。 | low |  |
| 239 | `list_voice_formats` |  | 列出支持的语音格式 | low |  |
| 240 | `send_voice_reply` |  | 回复消息并发送语音 | high |  |
| 241 | `publish_qzone_mood` |  | 发布QQ空间说说（心情动态）。 | high |  |
| 242 | `get_qzone_feeds` |  | 获取QQ空间说说列表。 | low |  |
| 243 | `like_qzone_post` |  | 点赞QQ空间说说。 | high |  |
| 244 | `delete_qzone_mood` |  | 删除自己的QQ空间说说。 | 危险 |  |
| 245 | `set_self_longnick` | `bot_account`（set_signature） | 设置机器人的个性签名/个人说明 | high | 🆕 |
| 246 | `friend_poke` |  | 戳一戳好友，兼容 icqq 和 NapCat/go-cqhttp | high |  |
| 247 | `group_poke` |  | 在群里戳一戳某人，兼容 icqq 和 NapCat/go-cqhttp | high |  |
| 248 | `get_profile_like` |  | 获取QQ资料卡点赞信息 | low |  |
| 249 | `create_collection` |  | 创建QQ收藏（将内容添加到QQ收藏夹） | high |  |
| 250 | `get_collection_list` |  | 获取QQ收藏列表 | low |  |
| 251 | `get_login_info` |  | 获取机器人登录账号的信息（QQ号、昵称等） | low |  |
| 252 | `get_bot_status` |  | 获取机器人运行状态 | low |  |
| 253 | `get_stranger_info` | `user_profile` | 获取陌生人信息 | low | ✅ |
| 254 | `get_version_info` |  | 获取机器人版本信息 | low |  |
| 255 | `get_online_clients` |  | 获取当前账号在线客户端列表 | low |  |
| 256 | `set_qq_avatar` | `bot_account`（set_avatar） | 设置机器人头像（危险操作） | 危险 | 🆕 |
| 257 | `get_model_show` |  | 获取机型显示信息 | low |  |
| 258 | `get_self_info` |  | 获取机器人自身的完整信息（综合） | low |  |
| 259 | `list_skills` | ikechan 内置 Skill | 列出所有可用的技能(skills)及其描述。 | low |  |
| 260 | `load_skill` | ikechan 内置 Skill | 读取指定技能的完整指令并在当前工具调用链中生效。 | low |  |
| 261 | `get_skill_info` | ikechan 内置 Skill | 获取指定技能的说明，包括正文指令、触发词、允许/禁止的工具列表，以及该技能包内可供读取的附… | low |  |
| 262 | `list_skill_files` | ikechan 内置 Skill | 列出指定技能包内可读取的附属文件（references/ 详细文档、assets/ 模板资… | low |  |
| 263 | `read_skill_file` | ikechan 内置 Skill | 读取技能包内由服务端确认为 UTF-8 文本的附属文件。 | low |  |
| 264 | `search_skills` | ikechan 内置 Skill | 按名称、说明或触发词搜索本地 Agent Skills；先搜索再按需调用 get_skil… | low |  |
| 265 | `unload_skill` | ikechan 内置 Skill | 从后续对话提示中卸载已显式加载的技能。 | low |  |
| 266 | `reload_skills` | ikechan 内置 Skill | 重新扫描 Skills 文档和所有工具注册表。 | low |  |
| 267 | `create_custom_tool` |  | 创建模型自定义 JavaScript 工具并原子热加载。 | 危险 |  |
| 268 | `update_custom_tool` |  | 覆盖更新模型自定义 JavaScript 工具并原子热加载；失败会恢复旧版本。 | 危险 |  |
| 269 | `invoke_custom_tool` |  | 在当前工具调用链中立即执行已热加载的模型自定义工具，解决当前模型客户端工具列表尚未重建的问… | 危险 |  |
| 270 | `delete_custom_tool` |  | 删除模型自定义 JavaScript 工具并热加载；失败会恢复原文件。 | 危险 |  |
| 271 | `mute_member` | `group_admin`（mute / unmute） | 禁言群成员，支持单个或批量禁言（需要管理员权限） | 危险 | ✅ |
| 272 | `kick_member` | `group_admin`（kick） | 踢出群成员，支持单个或批量踢人（需要管理员权限） | 危险 | ✅ |
| 273 | `set_group_card` | `group_admin`（set_card） | 设置群成员名片，支持单个或批量设置 | 危险 | ✅ |
| 274 | `set_group_whole_ban` | `group_admin`（mute_all） | 设置全群禁言（需要管理员权限） | 危险 | ✅ |
| 275 | `set_group_admin` |  | 设置/取消群管理员，支持单个或批量设置（需要群主权限） | 危险 |  |
| 276 | `set_group_name` |  | 修改群名称（需要管理员权限） | 危险 |  |
| 277 | `set_group_special_title` | `group_admin`（set_title） | 设置群成员专属头衔，支持单个或批量设置（需要群主权限） | 危险 | ✅ |
| 278 | `send_group_notice` |  | 发送群公告（需要管理员权限） | 危险 |  |
| 279 | `delete_group_notice` |  | 删除群公告（需要管理员权限） | 危险 |  |
| 280 | `set_group_add_request` | QQBot-Plugin 入群申请（#QQBot入群申请） | 处理加群申请 | 危险 |  |
| 281 | `set_friend_add_request` |  | 处理好友申请 | 危险 |  |
| 282 | `get_group_muted_list` |  | 获取群禁言列表 | low |  |
| 283 | `set_group_leave` | `bot_account`（quit_group） | 退出群聊（需谨慎使用） | 危险 | 🆕 |
| 284 | `delete_friend` | `bot_account`（delete_friend） | 删除好友（需谨慎使用） | 危险 | 🆕 |
| 285 | `set_group_portrait` |  | 设置群头像（需要管理员权限） | 危险 |  |
| 286 | `get_group_at_all_remain` |  | 获取群@全体成员剩余次数 | low |  |
| 287 | `set_group_anonymous_ban` |  | 禁言群匿名成员 | 危险 |  |
| 288 | `set_group_anonymous` |  | 设置群匿名功能开关 | 危险 |  |
| 289 | `get_group_system_msg` | QQBot-Plugin 入群申请（#QQBot入群申请） | 获取群系统消息（加群请求、邀请等） | low |  |
| 290 | `execute_command` | `shell` | 执行 Shell 命令。 | 危险 | ✅ |
| 291 | `get_system_info` | `shell` | 获取系统信息，包括操作系统、CPU、内存、磁盘等 | low | ✅ |
| 292 | `get_process_info` | `shell` | 获取当前 Node.js 进程信息 | low | ✅ |
| 293 | `read_env` |  | 读取环境变量 | 危险 |  |
| 294 | `yunzai_command` | `yunzai_command` | 按当前触发者权限搜索并执行 Yunzai 已加载的插件命令。 | high | ✅ |
| 295 | | `file_edit` | 按原文替换修改文本文件的一部分（框架文件修改前自动备份） | high | ✅ |
| 296 | | `file_restore` | 查看、还原框架文件的备份（仅主人） | high | ✅ |

</details>
