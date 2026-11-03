# 扩展技能

这里的每个目录是一个技能（Skill）：一份写给 AI 的“做事说明”，告诉它遇到某类请求时按什么步骤、用哪些工具、怎么回答。
技能本身不是工具，不能执行任何操作，干活的还是 `extra-tools` 里的工具；技能只是在需要时把说明临时加进系统提示词。

插件启动时（或主人发送 `#chatgpt同步工具`）自动把这些目录复制到 chaite 的技能目录 `data/skills/`，不用在面板或预设里勾选。

## 技能列表

| 技能 | 目录 | 什么时候启用 | 用到的工具 |
| --- | --- | --- | --- |
| 群聊总结 | `chat-summary` | 总结一下、爬楼、刚才聊了什么、错过了什么 | `search_chat_history`、`forward_msg`、`chat_context`、`member_info` |
| 读文件 | `file-reader` | 读一下、这个文件、文档、视频、语音、pdf、word、excel | `file_read`、`file_download`、`fetch_webpage`、`group_files`、`look_at_image` |
| 群文件整理 | `group-files` | 群文件、文件夹、重复文件、清理文件 | `group_files`、`file_download`、`file_read` |
| 群管处理 | `group-admin` | 禁言、踢出、撤回、全员禁言、头衔、入群申请、刷屏 | `group_admin`、`join_request`、`chat_context`、`member_info`、`group_members`、`search_chat_history` |
| 开源项目 | `github` | github、开源项目、这个仓库、最新版本、怎么安装 | `github_repo`、`fetch_webpage`、`web_search` |
| 机器人排查 | `bot-doctor` | 报错、日志、掉线、不回消息、运行状态 | `system_info`、`file_list`、`file_read`、`shell` |

技能只写做事的步骤，权限仍由工具判断：群管、群文件等操作照样按[权限设计原则](../extra-tools/README.md#风险工具群管shell账号设置等)走确认，
技能里也写明了“等待确认时如实告诉用户，不要绕过”。

## 技能是怎么启用的（ikechan 版 chaite）

每条消息发给 AI 前，chaite 用这条消息的文字给所有技能打分，分数最高的一个技能本轮启用，它的正文加到系统提示词末尾（`# Active skill: 名字`）。
只对这一轮有效，下一条消息重新打分；没有任何技能得分时不加。

打分规则（`SkillRegistry.matchSkill`）：

- 技能的 **名字、description、keywords** 里任何一项**整段出现**在消息里，每项加 2 分 —— 中文主要靠这一条，所以 `keywords` 要写用户真会说的短语
- 消息里每个**长度超过 2 的英文单词**，只要是名字、description、keywords 拼起来的文字的一部分，加 1 分
  （中文不会被拆成词，不参与这一条）
- 只看用户这条消息的文字（以及引用文件时插件加的“本条消息对一个文件进行了引用回复”），不看群聊上下文和图片
- 同分时先读到的技能优先

所以：

- 名字用中文，description 尽量不夹英文 —— 英文单词会让带同样单词的消息（包括网址里的 `com`、`www`）误启用技能
- 两个技能的关键词有包含关系时（“群文件”包含“文件”），在更具体的技能里把宽的词也写上，让它分数更高
- 关键词太宽（“看看”“帮我”）会让无关的聊天也带上这段说明，白白多花 token

## 怎么写一个技能

在这里新建一个目录（目录名用英文），里面放 `SKILL.md`：

```markdown
---
name: 群聊总结
description: 总结群里最近的聊天、爬楼
version: 1.0.0
keywords:
  - 总结一下
  - 爬楼
allowedTools:
  - search_chat_history
  - forward_msg
---

# 群聊总结

用户让你总结群聊、爬楼时，按下面做。
（正文：步骤、用哪个工具的哪个 action、怎么回答）
```

格式要求（chaite 只认一小部分 YAML）：

- 开头和结尾各一行 `---`，中间一行一个 `键: 值`；值不能换行，不要以 `[` 开头（会被当成数组）
- 列表写成 `键:` 换行后每行 `  - 项`；`keywords` 一定要写成列表，写成一行字符串会让对话出错
- 键可以写 `allowed-tools` 这样的短横线形式，会自动转成 `allowedTools`
- 正文放在 `---` 后面；目录里有 `system-prompt.md` 时用它代替正文

字段说明：

| 字段 | 作用 |
| --- | --- |
| `name` | 技能名，也是一个关键词；不写时用目录名 |
| `description` | 一句话说明，也参与打分 |
| `keywords` | 触发短语列表，最重要 |
| `version` | 版本号，只做显示 |
| `allowedTools` | 用到的工具，目前**只做记录**：普通对话（`executionMode` 默认 `direct`）不会限制 AI 只用这些工具，工具要在预设里照常勾选 |
| `readonly` | `true` 时面板不能修改、删除 |
| `executionMode` | `direct`（默认，加说明后照常对话）、`plan`、`workflow`；后两种走 chaite 的计划 / 工作流执行器，这里的技能都不用 |
| `preset` | 指定预设，目前不生效（对话开始前预设已经选好了） |

正文怎么写：

- 开头一句说清楚“什么情况下按这个做”，再加一句“不是这类请求就忽略这个技能”（关键词误命中时 AI 不会被带偏）
- 写步骤和判断，不要重复工具说明里已经有的参数解释
- 写清楚输出要求（纯文本、多少字以内、不要贴 QQ 号等）
- 越短越好：每次启用都会占系统提示词

## 同步规则

`data/skills/.extra-skills.json` 记着这里装进去的每个技能：

- 没改过的技能：这里更新了就覆盖，这里删掉了就一起删
- 在面板或文件里改过的：不再覆盖（同步时提示“改过，不覆盖”）；想恢复成这里的版本，删掉 `data/skills/<目录>` 再把记录文件里对应的一行删掉，然后同步
- 不想用某个技能：直接删掉 `data/skills/<目录>`，之后不会再装回来
- `data/skills` 里原来就有同名目录（主人自己写的）：不动

主人也可以让 AI 用 chaite 自带的 `list_skills`、`create_skill`、`update_skill`、`delete_skill` 管理技能（只有主人的对话里有这些工具，
预设的内置工具里不要关掉“技能管理”），这些技能直接写在 `data/skills`，和这里的同步互不影响。
