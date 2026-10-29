import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const chat = await import(pathToFileURL(path.resolve('./plugins/chatgpt-plugin/extra-tools/_chat.js')).href)

export class PokeUserTool extends CustomTool {
  name = 'poke_user'

  function = {
    name: 'poke_user',
    description: '在群里戳一戳某人（不填 user_id 就戳当前说话的人）。用户要你戳他、戳别人，或想调皮地互动时调用。',
    parameters: {
      type: 'object',
      properties: {
        user_id: {
          type: 'string',
          description: '要戳的人的 QQ 号，不填为当前说话的人'
        }
      },
      required: []
    }
  }

  async run (args, context) {
    const e = context?.getEvent?.()
    if (!e?.isGroup && !e?.group_id) return '戳一戳只能在群里用'
    const uid = chat.targetUser(e, args.user_id)
    try {
      const member = e.group?.pickMember?.(chat.asId(uid))
      if (typeof member?.poke === 'function') await member.poke()
      else if (typeof e.group?.pokeMember === 'function') await e.group.pokeMember(chat.asId(uid))
      else return '当前机器人不支持戳一戳'
      return `已经戳了戳 ${uid}，不需要再描述戳的动作`
    } catch (err) {
      return chat.errorText(err)
    }
  }
}

export default new PokeUserTool()
