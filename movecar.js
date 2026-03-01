/**
 * MoveCar 多用户智能挪车系统 - 并发隔离优化版
 * 隔离逻辑：每一个 KV 键值对都强制带上用户后缀，确保互不干扰
 */

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

const CONFIG = {
  KV_TTL: 3600,         // 状态有效期：1 小时
  RATE_LIMIT_TTL: 60    // 单用户发送频率限制：60 秒
}

async function handleRequest(request) {
  const url = new URL(request.url)
  const path = url.pathname
  
  // 1. 提取用户 ID (小写处理)
  const userParam = url.searchParams.get('u') || 'default';
  const userKey = userParam.toLowerCase();

  // --- API 路由区 ---
  if (path === '/api/notify' && request.method === 'POST') {
    return handleNotify(request, url, userKey);
  }
  if (path === '/api/get-location') {
    return handleGetLocation(userKey);
  }
  if (path === '/api/owner-confirm' && request.method === 'POST') {
    return handleOwnerConfirmAction(request, userKey);
  }
  if (path === '/api/check-status') {
    return handleCheckStatus(userKey);
  }

  // --- 页面路由区 ---
  if (path === '/owner-confirm') {
    return renderOwnerPage(userKey);
  }

  // 默认进入扫码挪车首页
  return renderMainPage(url.origin, userKey);
}

/** * 配置读取：优先读取 用户专用变量 (如 PUSHPLUS_TOKEN_NIANBA)
 */
function getUserConfig(userKey, envPrefix) {
  const specificKey = envPrefix + "_" + userKey.toUpperCase();
  if (typeof globalThis[specificKey] !== 'undefined') return globalThis[specificKey];
  if (typeof globalThis[envPrefix] !== 'undefined') return globalThis[envPrefix];
  return null;
}

// 坐标转换 (WGS-84 转 GCJ-02)
function wgs84ToGcj02(lat, lng) {
  const a = 6378245.0; const ee = 0.00669342162296594323;
  if (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271) return { lat, lng };
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = lat / 180.0 * Math.PI;
  let magic = Math.sin(radLat); magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI);
  dLng = (dLng * 180.0) / (a / sqrtMagic * Math.cos(radLat) * Math.PI);
  return { lat: lat + dLat, lng: lng + dLng };
}
function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
  return ret;
}
function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
  return ret;
}
function generateMapUrls(lat, lng, name) {
  const gcj = wgs84ToGcj02(lat, lng);
  const encodedName = encodeURIComponent(name);
  return {
    amapUrl: "https://uri.amap.com/marker?position=" + gcj.lng + "," + gcj.lat + "&name=" + encodedName,
    appleUrl: "https://maps.apple.com/?ll=" + gcj.lat + "," + gcj.lng + "&q=" + encodedName
  };
}

/** 发送通知逻辑 **/
async function handleNotify(request, url, userKey) {
  try {
    if (typeof MOVE_CAR_STATUS === 'undefined') throw new Error('KV 未绑定，请检查 Worker 设置');

    // --- 关键修改：锁定键带上 userKey，实现每个用户独立计时 ---
    const lockKey = "lock_" + userKey;
    const isLocked = await MOVE_CAR_STATUS.get(lockKey);
    if (isLocked) throw new Error('发送太频繁，请一分钟后再试');

    const body = await request.json();
    const message = body.message || '车旁有人等待';
    const location = body.location || null;
    const delayed = body.delayed || false;
    const lang = body.lang || 'zh-CN';

    // 获取配置
    const ppToken = getUserConfig(userKey, 'PUSHPLUS_TOKEN');
    const barkUrl = getUserConfig(userKey, 'BARK_URL');
    const tgToken = getUserConfig(userKey, 'TG_BOT_TOKEN');
    const tgChatId = getUserConfig(userKey, 'TG_CHAT_ID');
    const carTitle = getUserConfig(userKey, 'CAR_TITLE') || '车主';

    const baseDomain = (typeof EXTERNAL_URL !== 'undefined' && EXTERNAL_URL) ? EXTERNAL_URL.replace(/\/$/, "") : url.origin;
    const confirmUrl = baseDomain + "/owner-confirm?u=" + userKey;

    const backendI18n = {
      'zh-CN': { req: '挪车请求', msg: '留言', loc: '已附带对方位置', confirm: '点击确认前往', requesterName: '扫码者位置' },
      'zh-TW': { req: '挪車請求', msg: '留言', loc: '已附帶對方位置', confirm: '點擊確認前往', requesterName: '掃碼者位置' },
      'en': { req: 'Move Car Request', msg: 'Message', loc: 'Location attached', confirm: 'Click to confirm', requesterName: 'Requester Location' }
    };
    const t = backendI18n[lang] || backendI18n['zh-CN'];

    let notifyText = "🚗 " + t.req + "【" + carTitle + "】\n💬 " + t.msg + ": " + message;
    
    // 隔离存储位置
    if (location && location.lat) {
      const maps = generateMapUrls(location.lat, location.lng, t.requesterName);
      notifyText += "\n📍 " + t.loc;
      await MOVE_CAR_STATUS.put("loc_" + userKey, JSON.stringify({ ...location, ...maps }), { expirationTtl: CONFIG.KV_TTL });
    }

    // 隔离存储挪车状态
    await MOVE_CAR_STATUS.put("status_" + userKey, 'waiting', { expirationTtl: CONFIG.KV_TTL });
    await MOVE_CAR_STATUS.delete("owner_loc_" + userKey);
    
    // 设置针对该用户的 60秒 锁定
    await MOVE_CAR_STATUS.put(lockKey, '1', { expirationTtl: CONFIG.RATE_LIMIT_TTL });

    if (delayed) await new Promise(r => setTimeout(r, 30000));

    const tasks = [];
    const htmlMsg = notifyText.replace(/\n/g, '<br>') + '<br><br><a href="' + confirmUrl + '" style="font-weight:bold;color:#0093E9;font-size:18px;">【' + t.confirm + '】</a>';

    if (ppToken) {
      tasks.push(fetch('http://www.pushplus.plus/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: ppToken, title: "🚗 " + t.req + "：" + carTitle, content: htmlMsg, template: 'html' })
      }));
    }
    if (barkUrl) {
      let finalBarkUrl = barkUrl.startsWith('http') ? barkUrl : 'https://api.day.app/' + barkUrl;
      finalBarkUrl = finalBarkUrl.replace(/\/$/, "");
      tasks.push(fetch(finalBarkUrl + "/" + encodeURIComponent(t.req) + "/" + encodeURIComponent(notifyText) + "?url=" + encodeURIComponent(confirmUrl)));
    }
    if (tgToken && tgChatId) {
      const tgMsg = "🚗 <b>" + t.req + "：" + carTitle + "</b>\n💬 " + t.msg + ": " + message + (location ? "\n📍 " + t.loc : "") + "\n<a href=\"" + confirmUrl + "\">【" + t.confirm + "】</a>";
      tasks.push(fetch("https://api.telegram.org/bot" + tgToken + "/sendMessage", {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: tgChatId, text: tgMsg, parse_mode: 'HTML', disable_web_page_preview: true })
      }));
    }

    await Promise.all(tasks);
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500 });
  }
}

async function handleCheckStatus(userKey) {
  const status = await MOVE_CAR_STATUS.get("status_" + userKey);
  const ownerLoc = await MOVE_CAR_STATUS.get("owner_loc_" + userKey);
  return new Response(JSON.stringify({
    status: status || 'waiting',
    ownerLocation: ownerLoc ? JSON.parse(ownerLoc) : null
  }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleGetLocation(userKey) {
  const data = await MOVE_CAR_STATUS.get("loc_" + userKey);
  return new Response(data || '{}', { headers: { 'Content-Type': 'application/json' } });
}

async function handleOwnerConfirmAction(request, userKey) {
  const body = await request.json();
  const lang = body.lang || 'zh-CN';
  const ownerNames = {
    'zh-CN': '车主位置',
    'zh-TW': '車主位置',
    'en': 'Owner Location'
  };
  const ownerName = ownerNames[lang] || ownerNames['zh-CN'];

  if (body.location) {
    const urls = generateMapUrls(body.location.lat, body.location.lng, ownerName);
    await MOVE_CAR_STATUS.put("owner_loc_" + userKey, JSON.stringify({ ...body.location, ...urls }), { expirationTtl: 600 });
  }
  await MOVE_CAR_STATUS.put("status_" + userKey, 'confirmed', { expirationTtl: 600 });
  return new Response(JSON.stringify({ success: true }));
}

/** 界面渲染：请求者页 **/
function renderMainPage(origin, userKey) {
  const phone1 = getUserConfig(userKey, 'PHONE_NUMBER') || getUserConfig(userKey, 'PHONE_NUMBER_1') || '';
  const phone2 = getUserConfig(userKey, 'PHONE_NUMBER_2') || '';
  const phone3 = getUserConfig(userKey, 'PHONE_NUMBER_3') || '';
  const phones = [phone1, phone2, phone3].filter(Boolean);
  const carTitle = getUserConfig(userKey, 'CAR_TITLE') || '车主';
  
  let phoneHtml = '';
  let phoneModalHtml = '';

  if (phones.length === 1) {
    phoneHtml = `<a href="tel:${phones[0]}" class="btn-phone" id="btnPhone">📞 拨打车主电话</a>`;
  } else if (phones.length > 1) {
    phoneHtml = `<button onclick="document.getElementById('phoneModal').classList.remove('hidden')" class="btn-phone" id="btnPhone">📞 拨打车主电话</button>`;
    
    const phoneItems = phones.map((p, i) => `<a href="tel:${p}" class="phone-item">📞 ${p}</a>`).join('');
    phoneModalHtml = `
    <div id="phoneModal" class="modal hidden">
      <div class="modal-content">
        <h3 id="phoneModalTitle" style="margin-bottom: 15px; text-align: center;">请选择拨打的号码</h3>
        <div style="display: flex; flex-direction: column; gap: 10px;">
          ${phoneItems}
        </div>
        <button onclick="document.getElementById('phoneModal').classList.add('hidden')" style="margin-top: 15px; width: 100%; padding: 12px; border-radius: 12px; border: none; background: #f1f5f9; color: #475569; font-weight: bold; font-size: 16px; cursor: pointer;" id="btnCancelPhone">取消</button>
      </div>
    </div>`;
  }

  return new Response(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, viewport-fit=cover">
  <title>通知车主挪车</title>
  <style>
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; margin: 0; padding: 0; }
    body { font-family: sans-serif; background: linear-gradient(160deg, #0093E9 0%, #80D0C7 100%); min-height: 100vh; padding: 20px; display: flex; justify-content: center; }
    .container { width: 100%; max-width: 500px; display: flex; flex-direction: column; gap: 15px; }
    .card { background: white; border-radius: 24px; padding: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); }
    .header { text-align: center; }
    .icon-wrap { width: 70px; height: 70px; background: #0093E9; border-radius: 20px; display: flex; align-items: center; justify-content: center; margin: 0 auto 10px; font-size: 36px; color: white; }
    textarea { width: 100%; min-height: 100px; border: none; font-size: 16px; outline: none; resize: none; margin-top: 10px; }
    .tag-box { display: flex; gap: 8px; overflow-x: auto; margin-top: 10px; padding-bottom: 5px; }
    .tag { background: #f0f4f8; padding: 8px 16px; border-radius: 20px; font-size: 14px; white-space: nowrap; cursor: pointer; border: 1px solid #e1e8ed; }
    .btn-main { background: #0093E9; color: white; border: none; padding: 18px; border-radius: 18px; font-size: 18px; font-weight: bold; cursor: pointer; width: 100%; }
    .btn-phone { background: #ef4444; color: white; border: none; padding: 15px; border-radius: 15px; text-decoration: none; text-align: center; font-weight: bold; display: block; margin-top: 10px; width: 100%; cursor: pointer; font-size: 16px; }
    .btn-retry { background: #f59e0b; color: white; padding: 15px; border-radius: 15px; text-align: center; font-weight: bold; display: block; margin-top: 10px; border: none; width: 100%; cursor: pointer; font-size: 16px; }
    .hidden { display: none !important; }
    .map-links { display: flex; gap: 10px; margin-top: 15px; }
    .map-btn { flex: 1; padding: 12px; border-radius: 12px; text-align: center; text-decoration: none; color: white; font-size: 14px; font-weight: bold; }
    .amap { background: #1890ff; } .apple { background: #000; }
    .wx-mask { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.85); z-index: 9999; display: flex; flex-direction: column; align-items: flex-end; padding: 20px; color: white; font-size: 18px; line-height: 1.5; }
    .wx-mask-hidden { display: none !important; }
    .modal { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 1000; display: flex; justify-content: center; align-items: center; padding: 20px; }
    .modal-content { background: white; width: 100%; max-width: 320px; border-radius: 20px; padding: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.2); }
    .phone-item { display: block; width: 100%; padding: 15px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; text-align: center; text-decoration: none; color: #0f172a; font-weight: bold; font-size: 16px; }
  </style>
</head>
<body>
  <div id="wxMask" class="wx-mask wx-mask-hidden">
    <div style="text-align: right; width: 100%; padding-right: 10px;">
      <span style="font-size: 50px;">↗️</span>
    </div>
    <div style="margin-top: 20px; text-align: center; width: 100%;">
      <p id="wxMaskText1" style="font-size: 22px; font-weight: bold; margin-bottom: 10px;">请点击右上角 ···</p>
      <p id="wxMaskText2">选择在<span style="color:#0093E9;font-weight:bold;">浏览器</span>中打开</p>
      <p id="wxMaskText3" style="font-size: 14px; margin-top: 20px; color: #ccc;">(安卓微信无法获取定位，请在外部浏览器使用)</p>
    </div>
  </div>

  <div class="container" id="mainView">
    <div class="card header">
      <div class="icon-wrap">🚗</div>
      <h1 id="titleText">呼叫车主挪车</h1>
      <p style="color:#666; margin-top:5px"><span id="contactText">联络对象：</span>${carTitle}</p>
    </div>
    <div class="card">
      <textarea id="msgInput" placeholder="留言给车主..."></textarea>
      <div class="tag-box">
        <div class="tag" onclick="setTag(langData.tag1)">🚧 <span id="tag1Text">挡路</span></div>
        <div class="tag" onclick="setTag(langData.tag2)">⏱️ <span id="tag2Text">临停</span></div>
        <div class="tag" onclick="setTag(langData.tag4)">📞 <span id="tag4Text">没接</span></div>
        <div class="tag" onclick="setTag(langData.tag3)">🙏 <span id="tag3Text">加急</span></div>
      </div>
    </div>
    <div class="card" id="locStatus" style="font-size:14px; color:#666; text-align:center;">正在获取您的位置...</div>
    <button id="notifyBtn" class="btn-main" onclick="sendNotify()">🔔 <span id="btnNotifyText">发送通知</span></button>
  </div>

  <div class="container hidden" id="successView">
    <div class="card" style="text-align:center">
      <div style="font-size:60px; margin-bottom:15px">✅</div>
      <h2 style="margin-bottom:8px" id="successTitle">通知已发出</h2>
      <p id="waitingText" style="color:#666">车主微信已收到提醒，请稍候</p>
    </div>
    <div id="ownerFeedback" class="card hidden" style="text-align:center">
      <div style="font-size:40px">🏃♂️</div>
      <h3 style="color:#059669" id="ownerComingText">车主正赶往现场</h3>
      <div class="map-links">
        <a id="ownerAmap" href="#" class="map-btn amap" id="amapText">高德地图</a>
        <a id="ownerApple" href="#" class="map-btn apple" id="appleText">苹果地图</a>
      </div>
    </div>
    <div>
      <button class="btn-retry" onclick="location.reload()" id="btnRetryText">再次通知</button>
      ${phoneHtml}
    </div>
  </div>

  ${phoneModalHtml}

  <script>
    const i18n = {
      'zh-CN': {
        title: '呼叫车主挪车', contact: '联络对象：', placeholder: '留言给车主...',
        tag1: '您的车挡住我了', tag1Label: '挡路', tag2: '临时停靠一下', tag2Label: '临停', tag3: '急事，麻烦尽快', tag3Label: '加急', tag4: '电话没接，麻烦挪车', tag4Label: '没接',
        locGetting: '正在获取您的位置...', locSuccess: '📍 位置已锁定', locFail: '⚠️ 未能获取位置 (将延迟发送)',
        btnNotify: '发送通知', btnSending: '发送中...', btnPhone: '📞 拨打车主电话',
        successTitle: '通知已发出', waitingText: '车主已收到提醒，请稍候', ownerComing: '车主正赶往现场',
        amap: '高德地图', apple: '苹果地图', btnRetry: '再次通知', alertSuccess: '发送成功', alertFail: '系统忙',
        wxMask1: '请点击右上角 ···', wxMask2: '选择在浏览器中打开', wxMask3: '(安卓微信无法获取定位，请在外部浏览器使用)<br><br>💡 提示：允许位置能更快通知车主',
        phoneSelect: '请选择拨打的号码', cancel: '取消'
      },
      'zh-TW': {
        title: '呼叫車主挪車', contact: '聯絡對象：', placeholder: '留言給車主...',
        tag1: '您的車擋住我了', tag1Label: '擋路', tag2: '臨時停靠一下', tag2Label: '臨停', tag3: '急事，麻煩盡快', tag3Label: '加急', tag4: '電話沒接，麻煩挪車', tag4Label: '沒接',
        locGetting: '正在獲取您的位置...', locSuccess: '📍 位置已鎖定', locFail: '⚠️ 未能獲取位置 (將延遲發送)',
        btnNotify: '發送通知', btnSending: '發送中...', btnPhone: '📞 撥打車主電話',
        successTitle: '通知已發出', waitingText: '車主已收到提醒，請稍候', ownerComing: '車主正趕往現場',
        amap: '高德地圖', apple: '蘋果地圖', btnRetry: '再次通知', alertSuccess: '發送成功', alertFail: '系統忙',
        wxMask1: '請點擊右上角 ···', wxMask2: '選擇在瀏覽器中開啟', wxMask3: '(安卓微信無法獲取定位，請在外部瀏覽器使用)<br><br>💡 提示：允許位置能更快通知車主',
        phoneSelect: '請選擇撥打的號碼', cancel: '取消'
      },
      'en': {
        title: 'Move Car Request', contact: 'Contact: ', placeholder: 'Leave a message...',
        tag1: 'Your car is blocking me', tag1Label: 'Blocking', tag2: 'Temporary parking', tag2Label: 'Temp Park', tag3: 'Urgent, please hurry', tag3Label: 'Urgent', tag4: 'No answer on phone, please move', tag4Label: 'No Answer',
        locGetting: 'Getting your location...', locSuccess: '📍 Location locked', locFail: '⚠️ Failed to get location (Delayed)',
        btnNotify: 'Send Notification', btnSending: 'Sending...', btnPhone: '📞 Call Owner',
        successTitle: 'Notification Sent', waitingText: 'The owner has been notified, please wait.', ownerComing: 'Owner is on the way',
        amap: 'Amap', apple: 'Apple Maps', btnRetry: 'Notify Again', alertSuccess: 'Success', alertFail: 'System busy',
        wxMask1: 'Click the top right corner ···', wxMask2: 'Select "Open in Browser"', wxMask3: '(Location access is restricted in Android WeChat)<br><br>💡 Tip: Allowing location helps notify the owner faster',
        phoneSelect: 'Select a number to call', cancel: 'Cancel'
      }
    };

    let currentLang = navigator.language || navigator.userLanguage;
    const ua = navigator.userAgent || '';
    const wxLangMatch = ua.match(/Language\\/([a-zA-Z_-]+)/i);
    if (wxLangMatch) {
      currentLang = wxLangMatch[1].replace('_', '-');
    }

    let langCode = 'en';
    const lowerLang = (currentLang || 'en').toLowerCase();
    if (lowerLang.includes('tw') || lowerLang.includes('hk') || lowerLang.includes('mo') || lowerLang.includes('hant')) {
      langCode = 'zh-TW';
    } else if (lowerLang.startsWith('zh')) {
      langCode = 'zh-CN';
    }
    
    const langData = i18n[langCode];

    let userLoc = null;
    const userKey = "${userKey}";
    
    window.onload = () => {
      // Apply translation safely
      document.title = langData.title;
      const setTxt = (id, txt) => { const el = document.getElementById(id); if (el) el.innerText = txt; };
      const setHtml = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
      
      setTxt('titleText', langData.title);
      setTxt('contactText', langData.contact);
      const msgInput = document.getElementById('msgInput');
      if (msgInput) msgInput.placeholder = langData.placeholder;
      
      setTxt('tag1Text', langData.tag1Label);
      setTxt('tag2Text', langData.tag2Label);
      setTxt('tag4Text', langData.tag4Label);
      setTxt('tag3Text', langData.tag3Label);
      setTxt('locStatus', langData.locGetting);
      setTxt('btnNotifyText', langData.btnNotify);
      setTxt('successTitle', langData.successTitle);
      setTxt('waitingText', langData.waitingText);
      setTxt('ownerComingText', langData.ownerComing);
      setTxt('ownerAmap', langData.amap);
      setTxt('ownerApple', langData.apple);
      setTxt('btnRetryText', langData.btnRetry);
      setTxt('btnPhone', langData.btnPhone);
      setTxt('phoneModalTitle', langData.phoneSelect);
      setTxt('btnCancelPhone', langData.cancel);
      
      setTxt('wxMaskText1', langData.wxMask1);
      setHtml('wxMaskText2', langData.wxMask2 ? langData.wxMask2.replace('浏览器', '<span style="color:#0093E9;font-weight:bold;">浏览器</span>').replace('瀏覽器', '<span style="color:#0093E9;font-weight:bold;">瀏覽器</span>').replace('Browser', '<span style="color:#0093E9;font-weight:bold;">Browser</span>') : '');
      setHtml('wxMaskText3', langData.wxMask3);

      const isWechat = /MicroMessenger/i.test(ua);
      const isAndroid = /Android/i.test(ua);
      if (isWechat && isAndroid) {
        const mask = document.getElementById('wxMask');
        const main = document.getElementById('mainView');
        if (mask) mask.classList.remove('wx-mask-hidden');
        if (main) main.style.display = 'none';
        return; // Stop further execution if in Android WeChat
      }

      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(p => {
          userLoc = { lat: p.coords.latitude, lng: p.coords.longitude };
          document.getElementById('locStatus').innerText = langData.locSuccess;
          document.getElementById('locStatus').style.color = '#059669';
        }, () => {
          document.getElementById('locStatus').innerText = langData.locFail;
        });
      }
    };

    function setTag(t) { document.getElementById('msgInput').value = t; }

    async function sendNotify() {
      const btn = document.getElementById('notifyBtn');
      btn.disabled = true; btn.innerHTML = '🔔 <span id="btnNotifyText">' + langData.btnSending + '</span>';
      try {
        const res = await fetch('/api/notify?u=' + userKey, {
          method: 'POST',
          body: JSON.stringify({ message: document.getElementById('msgInput').value, location: userLoc, delayed: !userLoc, lang: langCode })
        });
        const data = await res.json();
        if (data.success) {
          document.getElementById('mainView').classList.add('hidden');
          document.getElementById('successView').classList.remove('hidden');
          pollStatus();
        } else { alert(data.error); btn.disabled = false; btn.innerHTML = '🔔 <span id="btnNotifyText">' + langData.btnNotify + '</span>'; }
      } catch(e) { alert(langData.alertFail); btn.disabled = false; btn.innerHTML = '🔔 <span id="btnNotifyText">' + langData.btnNotify + '</span>'; }
    }

    function pollStatus() {
      setInterval(async () => {
        const res = await fetch('/api/check-status?u=' + userKey);
        const data = await res.json();
        if (data.status === 'confirmed') {
          document.getElementById('ownerFeedback').classList.remove('hidden');
          if (data.ownerLocation) {
            document.getElementById('ownerAmap').href = data.ownerLocation.amapUrl;
            document.getElementById('ownerApple').href = data.ownerLocation.appleUrl;
          }
        }
      }, 4000);
    }
  </script>
</body>
</html>
`, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

/** 界面渲染：车主页 **/
function renderOwnerPage(userKey) {
  const carTitle = getUserConfig(userKey, 'CAR_TITLE') || '车主';
  return new Response(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>车主确认</title>
  <style>
    body { font-family: sans-serif; background: #667eea; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin:0; padding:20px; }
    .card { background: white; padding: 30px; border-radius: 28px; text-align: center; width: 100%; max-width: 400px; }
    .btn { background: #10b981; color: white; border: none; width: 100%; padding: 20px; border-radius: 16px; font-size: 18px; font-weight: bold; cursor: pointer; margin-top: 20px; }
    .map-box { display: none; background: #f0f4ff; padding: 15px; border-radius: 15px; margin-top: 15px; }
    .map-btn { display: inline-block; padding: 10px 15px; background: #1890ff; color: white; text-decoration: none; border-radius: 10px; margin: 5px; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <div style="font-size:45px">📢</div>
    <h2 style="margin:10px 0">${carTitle}</h2>
    <div id="mapArea" class="map-box">
      <p style="font-size:14px; color:#1e40af; margin-bottom:10px" id="locReceivedText">对方位置已送达 📍</p>
      <a id="amapLink" href="#" class="map-btn" id="amapText">高德地图</a>
      <a id="appleLink" href="#" class="map-btn" style="background:#000" id="appleText">苹果地图</a>
    </div>
    <button id="confirmBtn" class="btn" onclick="confirmMove()">🚀 <span id="btnConfirmText">我已知晓，马上过去</span></button>
  </div>
  <script>
    const i18n = {
      'zh-CN': {
        title: '车主确认', locReceived: '对方位置已送达 📍', amap: '高德地图', apple: '苹果地图',
        btnConfirm: '我已知晓，马上过去', btnConfirmed: '已同步给对方'
      },
      'zh-TW': {
        title: '車主確認', locReceived: '對方位置已送達 📍', amap: '高德地圖', apple: '蘋果地圖',
        btnConfirm: '我已知曉，馬上過去', btnConfirmed: '已同步給對方'
      },
      'en': {
        title: 'Owner Confirmation', locReceived: 'Location received 📍', amap: 'Amap', apple: 'Apple Maps',
        btnConfirm: 'Got it, on my way', btnConfirmed: 'Synced with requester'
      }
    };

    let currentLang = navigator.language || navigator.userLanguage;
    let langCode = 'en';
    const lowerLang = (currentLang || 'en').toLowerCase();
    if (lowerLang.includes('tw') || lowerLang.includes('hk') || lowerLang.includes('mo') || lowerLang.includes('hant')) {
      langCode = 'zh-TW';
    } else if (lowerLang.startsWith('zh')) {
      langCode = 'zh-CN';
    }
    
    const langData = i18n[langCode];

    const userKey = "${userKey}";
    window.onload = async () => {
      document.title = langData.title;
      document.getElementById('locReceivedText').innerText = langData.locReceived;
      document.getElementById('amapLink').innerText = langData.amap;
      document.getElementById('appleLink').innerText = langData.apple;
      document.getElementById('btnConfirmText').innerText = langData.btnConfirm;

      const res = await fetch('/api/get-location?u=' + userKey);
      const data = await res.json();
      if(data.amapUrl) {
        document.getElementById('mapArea').style.display = 'block';
        document.getElementById('amapLink').href = data.amapUrl;
        document.getElementById('appleLink').href = data.appleUrl;
      }
    };
    async function confirmMove() {
      const btn = document.getElementById('confirmBtn');
      btn.innerHTML = '🚀 <span id="btnConfirmText">' + langData.btnConfirmed + '</span>'; btn.disabled = true;
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(async p => {
          await fetch('/api/owner-confirm?u=' + userKey, { method: 'POST', body: JSON.stringify({ location: {lat: p.coords.latitude, lng: p.coords.longitude}, lang: langCode }) });
        }, async () => {
          await fetch('/api/owner-confirm?u=' + userKey, { method: 'POST', body: JSON.stringify({ location: null, lang: langCode }) });
        });
      } else {
        await fetch('/api/owner-confirm?u=' + userKey, { method: 'POST', body: JSON.stringify({ location: null, lang: langCode }) });
      }
    }
  </script>
</body>
</html>
`, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}
