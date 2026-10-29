import { CustomTool } from 'chaite'

/** wttr.in 的中文翻译不全，部分天气只有英文，这里补上常见的 */
const ZH = {
  sunny: '晴', clear: '晴', 'partly cloudy': '局部多云', cloudy: '多云', overcast: '阴',
  mist: '薄雾', fog: '雾', 'freezing fog': '冻雾', haze: '霾', 'smoky haze': '霾', smoke: '烟霾', 'dust': '浮尘',
  'patchy rain possible': '可能有零星小雨', 'patchy rain nearby': '附近有零星小雨', 'patchy light rain': '零星小雨',
  'light drizzle': '毛毛雨', 'patchy light drizzle': '零星毛毛雨', 'light rain': '小雨', 'moderate rain': '中雨',
  'moderate rain at times': '间歇中雨', 'heavy rain': '大雨', 'heavy rain at times': '间歇大雨',
  'light rain shower': '小阵雨', 'moderate or heavy rain shower': '中到大阵雨', 'torrential rain shower': '暴雨',
  'thundery outbreaks possible': '可能有雷暴', 'thundery outbreaks in nearby': '附近有雷暴',
  'patchy light rain with thunder': '零星雷阵雨', 'moderate or heavy rain with thunder': '中到大雷阵雨',
  'light snow': '小雪', 'moderate snow': '中雪', 'heavy snow': '大雪', 'patchy snow possible': '可能有零星小雪',
  'patchy light snow': '零星小雪', 'light snow showers': '小阵雪', blizzard: '暴风雪', 'blowing snow': '风吹雪',
  'light sleet': '小雨夹雪', 'moderate or heavy sleet': '中到大雨夹雪', 'patchy sleet possible': '可能有雨夹雪'
}
const zh = text => ZH[String(text).trim().toLowerCase()] || text

export class GetWeatherTool extends CustomTool {
  name = 'get_weather'

  function = {
    name: 'get_weather',
    description: '查询城市的实时天气和未来几天的天气预报。用户问天气、温度、会不会下雨、要不要带伞时调用，不要凭印象回答。',
    parameters: {
      type: 'object',
      properties: {
        city: {
          type: 'string',
          description: '城市名，中文或拼音，如“北京”“shanghai”'
        },
        days: {
          type: 'number',
          description: '预报天数，1-3，默认 1（只看今天）'
        }
      },
      required: ['city']
    }
  }

  async run (args) {
    const city = String(args.city || '').trim()
    if (!city) return '请提供城市名'
    const days = Math.min(Math.max(Number(args.days) || 1, 1), 3)
    try {
      const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=zh`, {
        headers: { 'User-Agent': 'curl/8.0' },
        signal: AbortSignal.timeout(10000)
      })
      if (!res.ok) return `查询天气失败（HTTP ${res.status}），请检查城市名`
      const data = await res.json()
      const cur = data.current_condition?.[0]
      if (!cur) return `没有找到“${city}”的天气`
      const desc = item => zh(item?.lang_zh?.[0]?.value || item?.weatherDesc?.[0]?.value || '')
      const area = data.nearest_area?.[0]
      const place = [...new Set([area?.areaName?.[0]?.value, area?.region?.[0]?.value].filter(Boolean))].join('，')
      const lines = [
        `${city}${place ? `（${place}）` : ''} 当前天气：${desc(cur)}`,
        `气温 ${cur.temp_C}°C，体感 ${cur.FeelsLikeC}°C，湿度 ${cur.humidity}%，${cur.winddir16Point} 风 ${cur.windspeedKmph}km/h，紫外线指数 ${cur.uvIndex}`
      ]
      for (const day of (data.weather || []).slice(0, days)) {
        const rain = Math.max(...(day.hourly || []).map(h => Number(h.chanceofrain) || 0))
        lines.push(`${day.date}：${desc(day.hourly?.[4])}，${day.mintempC}~${day.maxtempC}°C，降雨概率最高 ${rain}%`)
      }
      return lines.join('\n')
    } catch (err) {
      return `查询天气失败：${err.name === 'TimeoutError' ? '请求超时' : err.message}`
    }
  }
}

export default new GetWeatherTool()
