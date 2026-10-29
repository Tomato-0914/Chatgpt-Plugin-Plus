import { CustomTool } from 'chaite'

const LUNAR_DAYS = ['初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十']

/** 农历日期，如「丙午年九月二十」；运行环境不支持中国农历时返回空串 */
function lunarDate (date) {
  try {
    const parts = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {
      year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Shanghai'
    }).formatToParts(date)
    const get = type => parts.find(p => p.type === type)?.value || ''
    const year = get('yearName') || get('relatedYear')
    const day = LUNAR_DAYS[Number(get('day')) - 1] || get('day')
    return `${year}年${get('month')}${day}`
  } catch {
    return ''
  }
}

export class GetCurrentTimeTool extends CustomTool {
  name = 'get_current_time'

  function = {
    name: 'get_current_time',
    description: '获取当前的北京时间、星期和农历日期。回答与“现在、今天、明天、几号、星期几、还有几天”等时间相关的问题前先调用。',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  }

  async run () {
    const now = new Date()
    const time = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    const weekday = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'long' })
    const lunar = lunarDate(now)
    return `北京时间：${time} ${weekday}${lunar ? `\n农历：${lunar}` : ''}\n时间戳：${now.getTime()}`
  }
}

export default new GetCurrentTimeTool()
