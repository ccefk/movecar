/**
 * MoveCar 多用户智能挪车系统 - 并发隔离优化版
 * 隔离逻辑：每一个 KV 键值对都强制带上用户后缀，确保互不干扰
 */

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request, event))
})

const CONFIG = {
  KV_TTL: 3600,         // 状态有效期：1 小时
  SESSION_TTL: 1800,    // 挪车会话有效期：30 分钟 (1800秒)
  RATE_LIMIT_TTL: 60    // 单用户发送频率限制：60 秒
}

const COMMON_CLIENT_JS = `
    function getLangCode() {
      let currentLang = navigator.language || navigator.userLanguage;
      const ua = navigator.userAgent || '';
      const wxLangMatch = ua.match(/Language\\/([a-zA-Z_-]+)/i);
      if (wxLangMatch) currentLang = wxLangMatch[1].replace('_', '-');
      const lowerLang = (currentLang || 'en').toLowerCase();
      if (lowerLang.includes('tw') || lowerLang.includes('hk') || lowerLang.includes('mo') || lowerLang.includes('hant')) return 'zh-TW';
      if (lowerLang.startsWith('zh')) return 'zh-CN';
      return 'en';
    }
    function setupMapLink(elementId, type, lat, lng, name, webUrl) {
      const el = document.getElementById(elementId);
      if (!el) return;
      el.href = webUrl;
      el.onclick = (e) => {
        e.preventDefault();
        openMapApp(type, lat, lng, name, webUrl);
      };
    }
    let mapIframeOpen = false;

    function hideWeChatToolbar() {
      if (typeof WeixinJSBridge == "undefined") {
        if (document.addEventListener) {
          document.addEventListener('WeixinJSBridgeReady', function() { WeixinJSBridge.call('hideToolbar'); }, false);
        } else if (document.attachEvent) {
          document.attachEvent('WeixinJSBridgeReady', function() { WeixinJSBridge.call('hideToolbar'); });
          document.attachEvent('onWeixinJSBridgeReady', function() { WeixinJSBridge.call('hideToolbar'); });
        }
      } else {
        WeixinJSBridge.call('hideToolbar');
      }
    }
    
    // 页面加载时隐藏
    hideWeChatToolbar();

    function openMapIframe(webUrl) {
      if (mapIframeOpen) return;
      mapIframeOpen = true;
      
      const container = document.createElement('div');
      container.id = 'mapIframeContainer';
      container.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; z-index:9999; background:#fff; display:flex; flex-direction:column;';
      
      const iframeWrapper = document.createElement('div');
      iframeWrapper.style.cssText = 'flex:1; position:relative; width:100%; height:100%;';
      
      const iframe = document.createElement('iframe');
      iframe.id = 'mapIframe';
      iframe.style.cssText = 'position:absolute; top:0; left:0; width:100%; height:100%; border:none;';
      
      iframeWrapper.appendChild(iframe);
      
      const bottomBar = document.createElement('div');
      bottomBar.style.cssText = 'background:#fff; border-top:1px solid #e2e8f0; display:flex; align-items:center; justify-content:center; padding-top:12px; padding-bottom:calc(12px + env(safe-area-inset-bottom)); box-shadow:0 -4px 15px rgba(0,0,0,0.05);';
      
      const backBtn = document.createElement('button');
      backBtn.onclick = closeMapIframe;
      backBtn.style.cssText = 'display:flex; align-items:center; justify-content:center; padding:12px 40px; background:#e2e8f0; color:#475569; border-radius:8px; font-weight:bold; font-size:16px; border:none; cursor:pointer;';
      
      const backText = (typeof langData !== 'undefined' && langData.back) ? langData.back : '返回';
      backBtn.innerHTML = '<svg style="width:20px; height:20px; margin-right:6px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"></path></svg> <span>' + backText + '</span>';
      
      bottomBar.appendChild(backBtn);
      container.appendChild(iframeWrapper);
      container.appendChild(bottomBar);
      
      document.body.appendChild(container);
      
      // 再次确保隐藏
      hideWeChatToolbar();
      
      setTimeout(() => {
        iframe.src = webUrl;
      }, 0);
    }

    function closeMapIframe() {
      mapIframeOpen = false;
      const container = document.getElementById('mapIframeContainer');
      if (container) {
        container.parentNode.removeChild(container);
      }
      hideWeChatToolbar();
    }

    function openMapApp(type, lat, lng, name, webUrl) {
      const ua = navigator.userAgent.toLowerCase();
      const isWeChat = /micromessenger/.test(ua);
      const isIOS = /ipad|iphone|ipod/.test(ua) && !window.MSStream;
      const isAndroid = /android/.test(ua);

      if (isWeChat) {
        if (isIOS && type === 'amap') {
          openMapIframe(webUrl);
        } else {
          window.location.href = webUrl;
        }
        return;
      }
      if (isAndroid) {
        if (type === 'amap') window.location.href = 'intent://viewMap?sourceApplication=MoveCar&poiname=' + encodeURIComponent(name) + '&lat=' + lat + '&lon=' + lng + '&dev=0#Intent;scheme=androidamap;package=com.autonavi.minimap;S.browser_fallback_url=' + encodeURIComponent(webUrl) + ';end;';
        else window.location.href = webUrl;
        return;
      }
      if (isIOS) {
        if (type === 'apple') window.location.href = webUrl;
        else if (type === 'amap') {
          const start = Date.now();
          window.location.href = 'iosamap://viewMap?sourceApplication=MoveCar&poiname=' + encodeURIComponent(name) + '&lat=' + lat + '&lon=' + lng + '&dev=0';
          setTimeout(() => {
            if (!document.hidden && !document.webkitHidden && Date.now() - start < 3000) window.location.href = webUrl;
          }, 2000);
        }
        return;
      }
      window.location.href = webUrl;
    }
    function getFastLocation(onSuccess, onError, iosOptions) {
      if (!navigator.geolocation) return onError();
      if (/android/.test(navigator.userAgent.toLowerCase())) {
        let done = false, errors = 0;
        const s = (p) => { if(!done){ done=true; onSuccess(p); } };
        const e = () => { errors++; if(errors===2 && !done){ done=true; onError(); } };
        navigator.geolocation.getCurrentPosition(s, e, { enableHighAccuracy: false, timeout: 10000 });
        navigator.geolocation.getCurrentPosition(s, e, { enableHighAccuracy: true, timeout: 10000 });
      } else {
        navigator.geolocation.getCurrentPosition(onSuccess, onError, iosOptions);
      }
    }
`;

async function handleRequest(request, event) {
  const url = new URL(request.url)
  const path = url.pathname
  
  // 1. 提取用户 ID (小写处理)
  const userParam = url.searchParams.get('u') || 'default';
  const userKey = userParam.toLowerCase();

  // --- API 路由区 ---
  if (path === '/api/notify' && request.method === 'POST') {
    return handleNotify(request, url, userKey, event);
  }
  if (path === '/api/get-location') {
    return handleGetLocation(userKey);
  }
  if (path === '/api/owner-confirm' && request.method === 'POST') {
    return handleOwnerConfirmAction(request, userKey);
  }
  if (path === '/api/check-status') {
    const s = url.searchParams.get('s');
    return handleCheckStatus(userKey, s);
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
    appleUrl: "https://maps.apple.com/?ll=" + gcj.lat + "," + gcj.lng + "&q=" + encodedName,
    gcjLat: gcj.lat,
    gcjLng: gcj.lng,
    mapName: name
  };
}

/** 发送通知逻辑 **/
async function handleNotify(request, url, userKey, event) {
  try {
    if (typeof MOVE_CAR_STATUS === 'undefined') throw new Error('KV 未绑定，请检查 Worker 设置');

    const body = await request.json();
    const location = body.location || null;
    const delayed = body.delayed || false;
    const lang = body.lang || 'zh-CN';
    const sessionId = body.sessionId;

    const backendI18n = {
      'zh-CN': { req: '挪车请求', msg: '留言', loc: '已附带对方位置', confirm: '点击确认前往', requesterName: '扫码者位置', defaultMsg: '车旁有人等待', rateLimit: '发送太频繁，请一分钟后再试' },
      'zh-TW': { req: '移車請求', msg: '留言', loc: '已附帶對方位置', confirm: '點擊確認前往', requesterName: '掃碼者位置', defaultMsg: '車旁有人等待', rateLimit: '發送太頻繁，請一分鐘後再試' },
      'en': { req: 'Move Car Request', msg: 'Message', loc: 'Location attached', confirm: 'Click to confirm', requesterName: 'Requester Location', defaultMsg: 'Someone is waiting by the car', rateLimit: 'Sending too frequently, please try again in a minute' }
    };
    const t = backendI18n[lang] || backendI18n['zh-CN'];

    // --- 关键修改：锁定键带上 userKey，实现每个用户独立计时 ---
    const lockKey = "lock_" + userKey;
    const isLocked = await MOVE_CAR_STATUS.get(lockKey);
    if (isLocked) throw new Error(t.rateLimit);

    // 获取配置
    const ppToken = getUserConfig(userKey, 'PUSHPLUS_TOKEN');
    const barkUrl = getUserConfig(userKey, 'BARK_URL');
    const barkLogo = getUserConfig(userKey, 'BARK_LOGO');
    const tgToken = getUserConfig(userKey, 'TG_BOT_TOKEN');
    const tgChatId = getUserConfig(userKey, 'TG_CHAT_ID');
    const carTitle = getUserConfig(userKey, 'CAR_TITLE') || '车主';

    const baseDomain = (typeof EXTERNAL_URL !== 'undefined' && EXTERNAL_URL) ? EXTERNAL_URL.replace(/\/$/, "") : url.origin;
    const confirmUrl = baseDomain + "/owner-confirm?u=" + userKey + "&s=" + sessionId;
    
    const message = body.message || t.defaultMsg;

    let notifyText = "🚗 " + t.req + "【" + carTitle + "】\n💬 " + t.msg + ": " + message;
    
    // 隔离存储位置
    if (location && location.lat) {
      const maps = generateMapUrls(location.lat, location.lng, t.requesterName);
      notifyText += "\n📍 " + t.loc;
      await MOVE_CAR_STATUS.put("loc_" + userKey, JSON.stringify({ ...location, ...maps }), { expirationTtl: CONFIG.KV_TTL });
    }

    // 隔离存储挪车状态
    let statusData = { status: 'waiting', sessionId: sessionId };
    const existingStatusStr = await MOVE_CAR_STATUS.get("status_" + userKey);
    if (existingStatusStr) {
      try {
        const existingStatus = JSON.parse(existingStatusStr);
        if (existingStatus.sessionId === sessionId && existingStatus.status === 'confirmed') {
          statusData.status = 'confirmed';
        }
      } catch (e) {}
    }

    await MOVE_CAR_STATUS.put("status_" + userKey, JSON.stringify(statusData), { expirationTtl: CONFIG.SESSION_TTL });
    if (statusData.status !== 'confirmed') {
      await MOVE_CAR_STATUS.delete("owner_loc_" + userKey);
    }
    
    // 设置针对该用户的 60秒 锁定
    await MOVE_CAR_STATUS.put(lockKey, '1', { expirationTtl: CONFIG.RATE_LIMIT_TTL });

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
      let barkReqUrl = finalBarkUrl + "/" + encodeURIComponent(t.req) + "/" + encodeURIComponent(notifyText) + "?url=" + encodeURIComponent(confirmUrl);
      if (barkLogo) barkReqUrl += "&icon=" + encodeURIComponent(barkLogo);
      tasks.push(fetch(barkReqUrl));
    }
    if (tgToken && tgChatId) {
      const tgMsg = "🚗 <b>" + t.req + "：" + carTitle + "</b>\n💬 " + t.msg + ": " + message + (location ? "\n📍 " + t.loc : "") + "\n<a href=\"" + confirmUrl + "\">【" + t.confirm + "】</a>";
      tasks.push(fetch("https://api.telegram.org/bot" + tgToken + "/sendMessage", {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: tgChatId, text: tgMsg, parse_mode: 'HTML', disable_web_page_preview: true })
      }));
    }

    // Do not await tasks to speed up client response
    if (event && event.waitUntil) {
      event.waitUntil(Promise.allSettled(tasks));
    } else {
      Promise.allSettled(tasks).catch(console.error);
    }
    
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500 });
  }
}

async function handleCheckStatus(userKey, clientSessionId) {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  };

  const data = await MOVE_CAR_STATUS.get("status_" + userKey);
  if (!data) return new Response(JSON.stringify({ status: 'none' }), { headers });

  const statusObj = JSON.parse(data);
  if (statusObj.sessionId !== clientSessionId) {
    return new Response(JSON.stringify({ status: 'none' }), { headers });
  }

  const ownerLoc = await MOVE_CAR_STATUS.get("owner_loc_" + userKey);
  return new Response(JSON.stringify({
    status: statusObj.status,
    ownerLocation: ownerLoc ? JSON.parse(ownerLoc) : null
  }), { headers });
}

async function handleGetLocation(userKey) {
  const data = await MOVE_CAR_STATUS.get("loc_" + userKey);
  return new Response(data || '{}', { headers: { 'Content-Type': 'application/json' } });
}

async function handleOwnerConfirmAction(request, userKey) {
  const body = await request.json();
  const lang = body.lang || 'zh-CN';
  const sessionId = body.sessionId;
  const ownerNames = {
    'zh-CN': '车主位置',
    'zh-TW': '車主位置',
    'en': 'Owner Location'
  };
  const ownerName = ownerNames[lang] || ownerNames['zh-CN'];

  if (body.location) {
    const urls = generateMapUrls(body.location.lat, body.location.lng, ownerName);
    await MOVE_CAR_STATUS.put("owner_loc_" + userKey, JSON.stringify({ ...body.location, ...urls }), { expirationTtl: CONFIG.SESSION_TTL });
  }
  
  const data = await MOVE_CAR_STATUS.get("status_" + userKey);
  let statusObj = { status: 'confirmed', sessionId: sessionId };
  if (data) {
    try {
      const parsed = JSON.parse(data);
      statusObj = { ...parsed, status: 'confirmed' };
      if (sessionId) statusObj.sessionId = sessionId;
    } catch(e) {}
  }
  await MOVE_CAR_STATUS.put("status_" + userKey, JSON.stringify(statusObj), { expirationTtl: CONFIG.SESSION_TTL });
  
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
    .btn-home { background: #64748b; color: white; padding: 15px; border-radius: 15px; text-align: center; font-weight: bold; display: block; margin-top: 10px; border: none; width: 100%; cursor: pointer; font-size: 16px; }
    .hidden { display: none !important; }
    .map-links { display: flex; gap: 10px; margin-top: 15px; }
    .map-btn { flex: 1; padding: 12px; border-radius: 12px; text-align: center; text-decoration: none; color: white; font-size: 14px; font-weight: bold; }
    .amap { background: #1890ff; } .apple { background: #000; }
    .modal { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 1000; display: flex; justify-content: center; align-items: center; padding: 20px; }
    .modal-content { background: white; width: 100%; max-width: 320px; border-radius: 20px; padding: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.2); }
    .phone-item { display: block; width: 100%; padding: 15px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; text-align: center; text-decoration: none; color: #0f172a; font-weight: bold; font-size: 16px; }
    .custom-alert-mask { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 2000; display: flex; justify-content: center; align-items: center; padding: 20px; }
    .custom-alert-content { background: white; width: 100%; max-width: 320px; border-radius: 20px; padding: 25px 20px 20px; text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,0.2); }
    .custom-alert-btn { margin-top: 20px; width: 100%; padding: 12px; border-radius: 12px; border: none; background: #0093E9; color: white; font-weight: bold; font-size: 16px; cursor: pointer; }
    @keyframes runBounce {
      0%, 100% { transform: translateY(0) rotate(0deg); }
      25% { transform: translateY(-5px) rotate(-10deg); }
      50% { transform: translateY(0) rotate(0deg); }
      75% { transform: translateY(-5px) rotate(10deg); }
    }
    .running-man { display: inline-block; animation: runBounce 1s infinite; font-size: 50px; }
@keyframes spinHourglass {
  0%   { transform: rotate(0deg); }
  25%  { transform: rotate(180deg); }
  50%  { transform: rotate(180deg); } /* 6:00 位置停頓 */
  75%  { transform: rotate(360deg); }
  100% { transform: rotate(360deg); } /* 12:00 位置停頓 */
}

.hourglass {
  display: inline-block;
  animation: spinHourglass 2s ease-in-out infinite; /* 建議放慢一點看效果更順滑 */
  font-size: 18px;
  margin-left: 5px;
  vertical-align: middle;
  will-change: transform;
}
  </style>
</head>
<body>
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
      <p id="waitingText" style="color:#666; display:flex; align-items:center; justify-content:center;">车主微信已收到提醒，请稍候 <span class="hourglass">⏳</span></p>
    </div>
    <div id="ownerFeedback" class="card hidden" style="text-align:center">
      <div class="running-man">🏃‍♂️</div>
      <h3 style="color:#059669" id="ownerComingText">车主正赶往现场</h3>
      <div class="map-links hidden" id="mapLinks">
        <a id="ownerAmap" href="#" class="map-btn amap">高德地图</a>
        <a id="ownerApple" href="#" class="map-btn apple">苹果地图</a>
      </div>
    </div>
    <div>
      <button class="btn-retry" onclick="retryNotify()" id="btnRetryText">再次通知</button>
      ${phoneHtml}
    </div>
  </div>

  ${phoneModalHtml}

  <div id="retryModal" class="custom-alert-mask hidden">
    <div class="custom-alert-content">
      <p id="retryModalText" style="font-size: 16px; color: #333; line-height: 1.5; font-weight: bold; margin-bottom: 20px;">请选择操作</p>
      <div style="display: flex; gap: 10px;">
        <button class="btn-home" style="margin-top: 0; flex: 1; padding: 12px; font-size: 14px;" onclick="goHome()" id="modalBtnHomeText">🏠 回到主画面</button>
        <button class="btn-retry" style="margin-top: 0; flex: 1; padding: 12px; font-size: 14px;" onclick="executeRetry()" id="modalBtnRetryText">🔔 重复一次通知</button>
      </div>
      <button class="custom-alert-btn" style="background: #e2e8f0; color: #475569; margin-top: 15px;" onclick="closeRetryModal()" id="modalBtnCancelText">取消</button>
    </div>
  </div>

  <div id="customAlertModal" class="custom-alert-mask hidden">
    <div class="custom-alert-content">
      <p id="customAlertText" style="font-size: 16px; color: #333; line-height: 1.5; font-weight: bold;"></p>
      <button class="custom-alert-btn" onclick="closeCustomAlert()" id="customAlertBtnText">确定</button>
    </div>
  </div>

  <script>
    ${COMMON_CLIENT_JS}
    const i18n = {
      'zh-CN': {
        title: '呼叫车主挪车', contact: '联络对象：', placeholder: '留言给车主...',
        tag1: '您的车挡住我了', tag1Label: '挡路', tag2: '临时停靠一下', tag2Label: '临停', tag3: '急事，麻烦尽快', tag3Label: '加急', tag4: '电话没接，麻烦挪车', tag4Label: '没接',
        locGetting: '正在获取您的位置...', locSuccess: '📍 位置已锁定', locFail: '⚠️ 未能获取位置 (点击重试)',
        btnNotify: '发送通知', btnSending: '发送中...', btnPhone: '📞 拨打车主电话',
        successTitle: '通知已发出', waitingText: '车主已收到提醒，请稍候 <span class="hourglass">⏳</span>', ownerComing: '车主正赶往现场',
        amap: '🗺️ 高德地图', apple: '🍎 苹果地图', btnRetry: '🔔 再次通知', alertSuccess: '发送成功', alertFail: '系统忙',
        phoneSelect: '请选择拨打的号码', cancel: '取消', rateLimit: '发送太频繁，请一分钟后再试', confirmOk: '确定',
        btnHome: '🏠 回到主画面', resendSuccess: '再次通知已成功发送', retryModalTitle: '请选择操作', retryModalRetry: '🔔 重复一次通知', back: '返回'
      },
      'zh-TW': {
        title: '呼叫車主移車', contact: '聯絡對象：', placeholder: '留言給車主...',
        tag1: '您的車擋住我了', tag1Label: '擋路', tag2: '臨時停靠一下', tag2Label: '臨停', tag3: '急事，麻煩盡快', tag3Label: '加急', tag4: '電話沒接，麻煩移車', tag4Label: '沒接',
        locGetting: '正在獲取您的位置...', locSuccess: '📍 位置已鎖定', locFail: '⚠️ 未能獲取位置 (點擊重試)',
        btnNotify: '發送通知', btnSending: '發送中...', btnPhone: '📞 撥打車主電話',
        successTitle: '通知已發出', waitingText: '車主已收到提醒，請稍候 <span class="hourglass">⏳</span>', ownerComing: '車主正趕往現場',
        amap: '🗺️ 高德地圖', apple: '🍎 蘋果地圖', btnRetry: '🔔 再次通知', alertSuccess: '發送成功', alertFail: '系統忙',
        phoneSelect: '請選擇撥打的號碼', cancel: '取消', rateLimit: '發送太頻繁，請一分鐘後再試', confirmOk: '確定',
        btnHome: '🏠 回到主畫面', resendSuccess: '再次通知已成功發送', retryModalTitle: '請選擇操作', retryModalRetry: '🔔 重複一次通知', back: '返回'
      },
      'en': {
        title: 'Move Car Request', contact: 'Contact: ', placeholder: 'Leave a message...',
        tag1: 'Your car is blocking me', tag1Label: 'Blocking', tag2: 'Temporary parking', tag2Label: 'Temp Park', tag3: 'Urgent, please hurry', tag3Label: 'Urgent', tag4: 'No answer on phone, please move', tag4Label: 'No Answer',
        locGetting: 'Getting your location...', locSuccess: '📍 Location locked', locFail: '⚠️ Failed to get location (Click to retry)',
        btnNotify: 'Send Notification', btnSending: 'Sending...', btnPhone: '📞 Call Owner',
        successTitle: 'Notification Sent', waitingText: 'The owner has been notified, please wait <span class="hourglass">⏳</span>', ownerComing: 'Owner is on the way',
        amap: '🗺️ Amap', apple: '🍎 Apple Maps', btnRetry: '🔔 Notify Again', alertSuccess: 'Success', alertFail: 'System busy',
        phoneSelect: 'Select a number to call', cancel: 'Cancel', rateLimit: 'Sending too frequently, please try again in a minute', confirmOk: 'OK',
        btnHome: '🏠 Return to Home', resendSuccess: 'Notification resent successfully', retryModalTitle: 'Please select an action', retryModalRetry: '🔔 Resend Notification', back: 'Back'
      }
    };

    const langCode = getLangCode();
    const langData = i18n[langCode];

    function handleConfirmedStatus(data) {
      document.getElementById('ownerFeedback').classList.remove('hidden');
      if (data.ownerLocation) {
        setupMapLink('ownerAmap', 'amap', data.ownerLocation.gcjLat, data.ownerLocation.gcjLng, data.ownerLocation.mapName, data.ownerLocation.amapUrl);
        setupMapLink('ownerApple', 'apple', data.ownerLocation.gcjLat, data.ownerLocation.gcjLng, data.ownerLocation.mapName, data.ownerLocation.appleUrl);
        document.getElementById('mapLinks').classList.remove('hidden');
      }
      if (pollInterval) clearInterval(pollInterval);
    }

    function handleApiError(errorMsg) {
      if ([langData.rateLimit, '发送太频繁，请一分钟后再试', '發送太頻繁，請一分鐘後再試', 'Sending too frequently, please try again in a minute'].includes(errorMsg)) {
        document.getElementById('customAlertText').innerText = langData.rateLimit;
        document.getElementById('customAlertBtnText').innerText = langData.confirmOk;
        document.getElementById('customAlertModal').classList.remove('hidden');
      } else {
        alert(errorMsg);
      }
    }

    let userLoc = null;
    const userKey = "${userKey}";
    
    // 会话持久化
    let sessionId = localStorage.getItem('movecar_session_' + userKey);
    if (!sessionId) {
      sessionId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      localStorage.setItem('movecar_session_' + userKey, sessionId);
    }

    let pollInterval = null;
    let locationRequested = false;

    function updateLocStatus(text, color, cursor = 'default', onClick = null) {
      const locStatus = document.getElementById('locStatus');
      if (!locStatus) return;
      locStatus.innerText = text;
      locStatus.style.color = color;
      locStatus.style.cursor = cursor;
      locStatus.onclick = onClick;
      locStatus.style.display = 'block';
    }

    function requestLocation(forceRetry = false) {
      if (forceRetry) locationRequested = false;
      if (locationRequested || !navigator.geolocation) return;
      locationRequested = true;
      
      updateLocStatus(langData.locGetting, '#6b7280');

      const cachedLoc = sessionStorage.getItem('movecar_loc_' + userKey);
      if (cachedLoc) {
        try {
          userLoc = JSON.parse(cachedLoc);
          updateLocStatus(langData.locSuccess, '#059669');
          return;
        } catch(e) {}
      }

      getFastLocation(
        (p) => {
          userLoc = { lat: p.coords.latitude, lng: p.coords.longitude };
          sessionStorage.setItem('movecar_loc_' + userKey, JSON.stringify(userLoc));
          updateLocStatus(langData.locSuccess, '#059669');
        },
        () => updateLocStatus(langData.locFail, '#dc2626', 'pointer', () => requestLocation(true))
      );
    }

    window.onload = () => {
      checkActiveSession();
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
      document.getElementById('locStatus').style.display = 'none'; // Hide initially
      setTxt('btnNotifyText', langData.btnNotify);
      setTxt('successTitle', langData.successTitle);
      setHtml('waitingText', langData.waitingText);
      setTxt('ownerComingText', langData.ownerComing);
      setTxt('ownerAmap', langData.amap);
      setTxt('ownerApple', langData.apple);
      setTxt('btnRetryText', langData.btnRetry);
      setTxt('btnPhone', langData.btnPhone);
      setTxt('phoneModalTitle', langData.phoneSelect);
      setTxt('btnCancelPhone', langData.cancel);
      setTxt('retryModalText', langData.retryModalTitle);
      setTxt('modalBtnHomeText', langData.btnHome);
      setTxt('modalBtnRetryText', langData.retryModalRetry);
      setTxt('modalBtnCancelText', langData.cancel);

      requestLocation();
    };

    async function checkActiveSession() {
      try {
        const res = await fetch('/api/check-status?u=' + userKey + '&s=' + sessionId + '&t=' + Date.now(), {
          cache: 'no-store'
        });
        const data = await res.json();
        if (data.status && data.status !== 'none') {
          document.getElementById('mainView').classList.add('hidden');
          document.getElementById('successView').classList.remove('hidden');
          if (data.status === 'confirmed') {
            handleConfirmedStatus(data);
          }
          startPolling();
        }
      } catch(e){}
    }

    function setTag(t) { 
      document.getElementById('msgInput').value = t; 
      requestLocation();
    }

    function checkLocalRateLimit() {
      const lastSend = localStorage.getItem('movecar_last_send_' + userKey);
      if (lastSend && Date.now() - parseInt(lastSend) < 60000) {
        handleApiError(langData.rateLimit);
        return true;
      }
      return false;
    }

    async function doNotifyFetch() {
      const res = await fetch('/api/notify?u=' + userKey, {
        method: 'POST',
        body: JSON.stringify({ message: document.getElementById('msgInput').value, location: userLoc, delayed: !userLoc, lang: langCode, sessionId: sessionId })
      });
      return await res.json();
    }

    async function sendNotify() {
      if (checkLocalRateLimit()) return;

      const btn = document.getElementById('notifyBtn');
      btn.disabled = true; btn.innerHTML = '🔔 <span id="btnNotifyText">' + langData.btnSending + '</span>';
      
      // If location is not yet available but requested, wait briefly (max 2s)
      if (!userLoc && locationRequested) {
        let waitTime = 0;
        while (!userLoc && waitTime < 2000) {
          await new Promise(r => setTimeout(r, 200));
          waitTime += 200;
        }
      }

      try {
        const data = await doNotifyFetch();
        if (data.success) {
          localStorage.setItem('movecar_last_send_' + userKey, Date.now());
          document.getElementById('mainView').classList.add('hidden');
          document.getElementById('successView').classList.remove('hidden');
          startPolling();
        } else {
          handleApiError(data.error);
          btn.disabled = false; btn.innerHTML = '🔔 <span id="btnNotifyText">' + langData.btnNotify + '</span>';
        }
      } catch(e) { alert(langData.alertFail); btn.disabled = false; btn.innerHTML = '🔔 <span id="btnNotifyText">' + langData.btnNotify + '</span>'; }
    }

    function retryNotify() {
      if (checkLocalRateLimit()) return;
      document.getElementById('retryModal').classList.remove('hidden');
    }

    function closeRetryModal() {
      document.getElementById('retryModal').classList.add('hidden');
    }

    async function executeRetry() {
      closeRetryModal();
      const btn = document.getElementById('btnRetryText');
      const originalText = btn.innerText;
      btn.innerText = langData.btnSending;
      try {
        const data = await doNotifyFetch();
        if (data.success) {
          localStorage.setItem('movecar_last_send_' + userKey, Date.now());
          document.getElementById('customAlertText').innerText = langData.resendSuccess;
          document.getElementById('customAlertBtnText').innerText = langData.confirmOk;
          document.getElementById('customAlertModal').classList.remove('hidden');
        } else {
          handleApiError(data.error);
        }
      } catch(e) {
        alert(langData.alertFail);
      }
      btn.innerText = originalText;
    }

    function closeCustomAlert() {
      document.getElementById('customAlertModal').classList.add('hidden');
      checkStatusNow(); // 强制即时轮询
    }

    async function checkStatusNow() {
      try {
        const res = await fetch('/api/check-status?u=' + userKey + '&s=' + sessionId + '&t=' + Date.now(), { cache: 'no-store' });
        const data = await res.json();
        if (data.status === 'confirmed') {
          handleConfirmedStatus(data);
        }
      } catch(e) {}
    }

    function goHome() {
      localStorage.removeItem('movecar_session_' + userKey);
      location.reload();
    }

    function startPolling() {
      if (pollInterval) clearInterval(pollInterval);
      pollInterval = setInterval(async () => {
        try {
          const res = await fetch('/api/check-status?u=' + userKey + '&s=' + sessionId + '&t=' + Date.now(), {
            cache: 'no-store'
          });
          const data = await res.json();
          if (data.status === 'confirmed') {
            handleConfirmedStatus(data);
          }
        } catch(e) {}
      }, 2000);
    }

    // 監聽頁面可見性變化 (解決安卓休眠後定時器暫停的問題)
    document.addEventListener("visibilitychange", function() {
      if (document.visibilityState === 'visible') {
        checkStatusNow(); // 回到畫面時立即查詢一次
      }
    });
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
      <a id="amapLink" href="#" class="map-btn">高德地图</a>
      <a id="appleLink" href="#" class="map-btn" style="background:#000">苹果地图</a>
    </div>
    <button id="confirmBtn" class="btn" onclick="confirmMove()">🚀 <span id="btnConfirmText">我已知晓，马上过去</span></button>
  </div>
  <script>
    ${COMMON_CLIENT_JS}
    const i18n = {
      'zh-CN': {
        title: '车主确认', locReceived: '对方位置已送达 📍', amap: '🗺️ 高德地图', apple: '🍎 苹果地图',
        btnConfirm: '我已知晓，马上过去', btnConfirmed: '已同步给对方', btnSending: '发送中...', back: '返回'
      },
      'zh-TW': {
        title: '車主確認', locReceived: '對方位置已送達 📍', amap: '🗺️ 高德地圖', apple: '🍎 蘋果地圖',
        btnConfirm: '我已知曉，馬上過去', btnConfirmed: '已同步給對方', btnSending: '發送中...', back: '返回'
      },
      'en': {
        title: 'Owner Confirmation', locReceived: 'Location received 📍', amap: '🗺️ Amap', apple: '🍎 Apple Maps',
        btnConfirm: 'Got it, on my way', btnConfirmed: 'Synced with requester', btnSending: 'Sending...', back: 'Back'
      }
    };

    const langCode = getLangCode();
    const langData = i18n[langCode];

    const userKey = "${userKey}";
    const urlParams = new URLSearchParams(window.location.search);
    const sessionId = urlParams.get('s');
    
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
        setupMapLink('amapLink', 'amap', data.gcjLat, data.gcjLng, data.mapName, data.amapUrl);
        setupMapLink('appleLink', 'apple', data.gcjLat, data.gcjLng, data.mapName, data.appleUrl);
      }
    };

    async function confirmMove() {
      const btn = document.getElementById('confirmBtn');
      if (btn.disabled) return;
      btn.disabled = true;

      let isLocSent = false;
      const sendLocation = async (loc) => {
        if (isLocSent) return;
        isLocSent = true;
        
        btn.innerHTML = '⏳ <span id="btnConfirmText">' + langData.btnSending + '</span>';
        
        try {
          await fetch('/api/owner-confirm?u=' + userKey, { method: 'POST', body: JSON.stringify({ location: loc, lang: langCode, sessionId: sessionId }) });
        } catch(e) {}
        
        btn.innerHTML = '🚀 <span id="btnConfirmText">' + langData.btnConfirmed + '</span>';
      };

      if (navigator.geolocation) {
        let promptAnswered = false;
        const showSending = () => {
          if (!promptAnswered && !isLocSent) {
            promptAnswered = true;
            btn.innerHTML = '⏳ <span id="btnConfirmText">' + langData.btnSending + '</span>';
          }
        };

        if (navigator.permissions) {
          navigator.permissions.query({name: 'geolocation'}).then(res => {
            if (res.state !== 'prompt') {
              showSending();
            } else {
              res.onchange = () => {
                if (res.state !== 'prompt') showSending();
              };
            }
          }).catch(e => {});
        }

        getFastLocation(
          p => { showSending(); sendLocation({lat: p.coords.latitude, lng: p.coords.longitude}); },
          () => { showSending(); sendLocation(null); },
          { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
        );
      } else {
        sendLocation(null);
      }
    }
  </script>
</body>
</html>
`, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}
