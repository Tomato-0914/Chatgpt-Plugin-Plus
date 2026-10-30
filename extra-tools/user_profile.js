import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const chat = await import(pathToFileURL(path.resolve('./plugins/chatgpt-plugin/extra-tools/_chat.js')).href)

const SEX = { male: '男', female: '女' }
const avatarUrl = uid => `https://q1.qlogo.cn/g?b=qq&nk=${uid}&s=640`
const date = t => (Number(t) > 0 ? chat.beijing(Number(t) * 1000, { dateStyle: 'medium' }) : '')

/** 陌生人资料：OneBot 的 get_stranger_info（NapCat 字段最全），ICQQ 的 getStrangerInfo / getSimpleInfo */
async function profile (bot, uid) {
  return await chat.invoke([
    [bot, 'sendApi', ['get_stranger_info', { user_id: Number(uid), no_cache: true }]],
    [bot, 'getStrangerInfo', [Number(uid)]],
    [bot.pickUser?.(Number(uid)), 'getSimpleInfo']
  ], '查询 QQ 资料')
}

function format (uid, d) {
  const place = [d.country, d.province, d.city].filter(v => v && v !== '0').join(' ') || d.area
  const birthday = d.birthday_year && d.birthday_month ? `${d.birthday_year}-${d.birthday_month}-${d.birthday_day}` : ''
  return [
    ['QQ', d.user_id || uid],
    ['昵称', d.nickname || d.nick],
    ['QID', d.qid],
    ['性别', SEX[d.sex] || ''],
    ['年龄', Number(d.age) > 0 ? d.age : ''],
    ['生日', birthday],
    ['地区', place],
    ['QQ 等级', Number(d.level || d.qqLevel) > 0 ? d.level || d.qqLevel : ''],
    ['会员', d.is_vip || d.vip_level ? `${d.is_years_vip ? '年费' : ''}会员${d.vip_level ? ` VIP${d.vip_level}` : ''}` : ''],
    ['个性签名', d.long_nick || d.sign || d.signature],
    ['注册时间', date(d.reg_time || d.regTime)],
    ['连续登录', Number(d.login_days) > 0 ? `${d.login_days} 天` : '']
  ].filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}：${v}`).join('\n')
}

export class UserProfileTool extends CustomTool {
  name = 'user_profile'

  function = {
    name: 'user_profile',
    description: '查看某人的 QQ 资料卡：昵称、性别、年龄、地区、QQ 等级、会员、个性签名、注册时间等（需要野生号），也可以把头像发出来。' +
      '查群名片、群身份、入群时间用 member_info。',
    parameters: {
      type: 'object',
      properties: {
        user_id: {
          type: 'string',
          description: 'QQ 号，不填为当前说话的人'
        },
        send_avatar: {
          type: 'boolean',
          description: '是否把头像图片发到聊天里，默认 false'
        }
      },
      required: []
    }
  }

  async run (args, context) {
    const e = context?.getEvent?.()
    if (!e) return '拿不到当前消息'
    try {
      const raw = chat.targetUser(e, args.user_id)
      const uid = await chat.realQQ(e, raw)
      if (!uid) return '这个用户还没有绑定 QQ 号，查不到资料卡'
      let text
      const bot = chat.anyWild(e)
      if (!bot) {
        text = '没有在线的野生号，查不了资料卡（官方机器人没有这个接口）'
      } else {
        try {
          text = format(uid, await profile(bot, uid) || {}) || '没有查到资料'
        } catch (err) {
          text = `查询资料卡失败：${err.message}`
        }
      }
      text += `\n头像：${avatarUrl(uid)}`
      if (args.send_avatar) {
        const ret = await e.reply({ type: 'image', file: avatarUrl(uid) })
        text += chat.sent(ret) ? '\n（头像已发到聊天里）' : `\n（头像发送失败：${chat.failReason(ret)}）`
      }
      return text
    } catch (err) {
      return chat.errorText(err)
    }
  }
}

export default new UserProfileTool()
