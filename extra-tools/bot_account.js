import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const dir = './plugins/chatgpt-plugin/extra-tools'
const chat = await import(pathToFileURL(path.resolve(dir, '_chat.js')).href)
const approval = await import(pathToFileURL(path.resolve(dir, '_approval.js')).href)

const isQQ = id => /^\d{5,12}$/.test(String(id ?? ''))
const short = text => (text.length > 30 ? `${text.slice(0, 30)}…` : text)

/** 每个操作：检查参数并返回 { title, run }，run 在主人确认后执行 */
const ACTIONS = {
  quit_group (e, args) {
    const gid = String(args.group_id ?? '').trim() || (e.isGroup || e.group_id ? String(e.group_id) : '')
    if (!isQQ(gid)) return '请提供要退出的群号'
    const bot = chat.wildInGroup(gid)
    if (!bot) return `野生号不在群 ${gid} 里`
    return {
      title: `让野生号 ${bot.uin} 退出群 ${gid}`,
      run: async () => {
        await chat.invoke([[bot.pickGroup(Number(gid)), 'quit'], [bot, 'sendApi', ['set_group_leave', { group_id: Number(gid) }]]], '退群')
        return `野生号 ${bot.uin} 已退出群 ${gid}`
      }
    }
  },

  async delete_friend (e, args) {
    const uid = await chat.realQQ(e, String(args.user_id ?? '').replace(/^@/, '').trim())
    if (!uid) return '请提供要删除的好友 QQ 号'
    const bot = chat.anyWild(e)
    if (!bot) return '没有在线的野生号'
    if (bot.fl && !bot.fl.has(Number(uid)) && !bot.fl.has(uid)) return `${uid} 不是野生号 ${bot.uin} 的好友`
    return {
      title: `让野生号 ${bot.uin} 删除好友 ${uid}`,
      run: async () => {
        await chat.invoke([
          [bot, 'deleteFriend', [Number(uid)]],
          [bot.pickFriend?.(Number(uid)), 'delete'],
          [bot, 'sendApi', ['delete_friend', { user_id: Number(uid), friend_id: Number(uid) }]]
        ], '删除好友')
        return `野生号 ${bot.uin} 已删除好友 ${uid}`
      }
    }
  },

  set_avatar (e, args) {
    const url = String(args.image_url ?? '').trim() || (Array.isArray(e.img) ? e.img[0] : '')
    if (!/^https?:\/\//i.test(url)) return '请提供新头像的图片地址（或在消息里附上图片）'
    const bot = chat.anyWild(e)
    if (!bot) return '没有在线的野生号'
    return {
      title: `把野生号 ${bot.uin} 的头像换成 ${short(url)}`,
      run: async () => {
        await chat.invoke([[bot, 'setAvatar', [url]], [bot, 'sendApi', ['set_qq_avatar', { file: url }]]], '修改头像')
        return `野生号 ${bot.uin} 的头像已更换`
      }
    }
  },

  set_nickname (e, args) {
    const nickname = String(args.text ?? '').trim()
    if (!nickname) return '请提供新昵称'
    if (nickname.length > 36) return '昵称太长了'
    const bot = chat.anyWild(e)
    if (!bot) return '没有在线的野生号'
    return {
      title: `把野生号 ${bot.uin} 的昵称改成「${nickname}」`,
      run: async () => {
        await chat.invoke([[bot, 'setNickname', [nickname]], [bot, 'sendApi', ['set_qq_profile', { nickname }]]], '修改昵称')
        return `野生号 ${bot.uin} 的昵称已改成「${nickname}」`
      }
    }
  },

  set_signature (e, args) {
    const text = String(args.text ?? '').trim()
    if (text.length > 100) return '个性签名太长了，最多 100 字'
    const bot = chat.anyWild(e)
    if (!bot) return '没有在线的野生号'
    return {
      title: text ? `把野生号 ${bot.uin} 的个性签名改成「${short(text)}」` : `清空野生号 ${bot.uin} 的个性签名`,
      run: async () => {
        await chat.invoke([[bot, 'setSignature', [text]], [bot, 'sendApi', ['set_self_longnick', { longNick: text, long_nick: text }]]], '修改个性签名')
        return `野生号 ${bot.uin} 的个性签名已${text ? `改成「${text}」` : '清空'}`
      }
    }
  },

  set_card (e, args) {
    const gid = String(args.group_id ?? '').trim() || (e.isGroup || e.group_id ? String(e.group_id) : '')
    if (!isQQ(gid)) return '请提供群号'
    const card = String(args.text ?? '').trim()
    if (card.length > 60) return '群名片太长了'
    const bot = chat.wildInGroup(gid)
    if (!bot) return `野生号不在群 ${gid} 里`
    return {
      title: card ? `把野生号 ${bot.uin} 在群 ${gid} 的群名片改成「${card}」` : `清空野生号 ${bot.uin} 在群 ${gid} 的群名片`,
      run: async () => {
        await chat.invoke([
          [bot.pickGroup(Number(gid)), 'setCard', [bot.uin, card]],
          [bot, 'setGroupCard', [Number(gid), bot.uin, card]],
          [bot, 'sendApi', ['set_group_card', { group_id: Number(gid), user_id: Number(bot.uin), card }]]
        ], '修改群名片')
        return `野生号 ${bot.uin} 在群 ${gid} 的群名片已${card ? `改成「${card}」` : '清空'}`
      }
    }
  }
}

export class BotAccountTool extends CustomTool {
  name = 'bot_account'

  function = {
    name: 'bot_account',
    description: '管理机器人（野生号）自己的账号：退出某个群（quit_group）、删除好友（delete_friend）、换头像（set_avatar）、' +
      '改昵称（set_nickname）、改个性签名（set_signature）、改自己在群里的群名片（set_card）。官方机器人做不了这些，都由野生号执行。' +
      '主人要求时直接执行；其他人要求时会 @ 主人申请确认，主人确认后才执行（告诉用户等主人确认即可）。改群友的名片用 group_admin。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: Object.keys(ACTIONS),
          description: 'quit_group=退群；delete_friend=删好友；set_avatar=换头像；set_nickname=改昵称；set_signature=改个性签名；set_card=改自己的群名片'
        },
        text: {
          type: 'string',
          description: 'set_nickname / set_signature / set_card 时的新内容（签名、群名片留空为清空）'
        },
        group_id: {
          type: 'string',
          description: 'quit_group / set_card 时的群号，不填为当前群'
        },
        user_id: {
          type: 'string',
          description: 'delete_friend 时要删除的好友 QQ 号'
        },
        image_url: {
          type: 'string',
          description: 'set_avatar 时新头像的图片地址；不填时用消息里附带的图片'
        }
      },
      required: ['action']
    }
  }

  async run (args, context) {
    const e = context?.getEvent?.()
    if (!e) return '拿不到当前消息'
    const action = ACTIONS[args.action]
    if (!action) return `不支持的操作：${args.action}`
    try {
      const plan = await action(e, args)
      if (typeof plan === 'string') return plan
      return await approval.guard(e, plan)
    } catch (err) {
      return chat.errorText(err)
    }
  }
}

export default new BotAccountTool()
