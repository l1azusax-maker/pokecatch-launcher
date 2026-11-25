'use strict';

const http = require('http');
const crypto = require('crypto');

function buildCallbackHtml(nonce) {
  const safeNonce = JSON.stringify(String(nonce || ''));
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<title>PokeCatch 登录</title><style>'
    + 'html,body{height:100%;margin:0}'
    + 'body{display:flex;align-items:center;justify-content:center;background:#141826;color:#e8eaf2;'
    + 'font:15px/1.6 "Segoe UI",system-ui,sans-serif}'
    + '.box{text-align:center;padding:26px 34px;border:1px solid #333a52;border-radius:12px;background:#1b2033;min-width:300px}'
    + 'h1{font-size:16px;margin:0 0 8px;font-weight:600}'
    + 'p{margin:0;color:#9aa3bd;font-size:13px}'
    + '.dot{width:9px;height:9px;border-radius:50%;background:#e3353b;display:inline-block;margin-right:7px;vertical-align:1px}'
    + '</style></head><body><div class="box"><h1><span class="dot"></span><span id="t">正在完成登录…</span></h1>'
    + '<p id="d">请稍候，完成后可以直接关闭此页面</p></div><script>'
    + '(function(){var raw=location.hash?location.hash.slice(1):location.search.slice(1);'
    + 'if(!raw){document.getElementById("t").textContent="没有收到登录结果";return;}'
    + 'fetch("/payload",{method:"POST",headers:{"content-type":"text/plain","x-pc-auth-nonce":' + safeNonce + '},body:raw})'
    + '.then(function(r){if(!r.ok)throw new Error("HTTP "+r.status);'
    + 'document.getElementById("t").textContent="登录成功";'
    + 'document.getElementById("d").textContent="已返回启动器，可以关闭此页面";'
    + 'setTimeout(function(){try{window.close();}catch(e){}},900);})'
    + '.catch(function(){document.getElementById("t").textContent="回传失败";'
    + 'document.getElementById("d").textContent="请回到启动器重试";});})();'
    + '</script></body></html>';
}

function createAuthBridge({
  openExternal,
  onSuccess,
  onFailure,
  onBeforeOpen,
  dbg = () => {},
  timeoutMs = 5 * 60 * 1000,
}) {
  let authFlow = null;

  function close() {
    if (!authFlow) return;
    const f = authFlow;
    authFlow = null;
    try { clearTimeout(f.timer); } catch (_) {}
    try { f.server.close(); } catch (_) {}
  }

  function finish(raw) {
    if (!authFlow) return;
    const q = new URLSearchParams(raw || '');
    const token = q.get('access_token');
    const code = q.get('code');
    const err = q.get('error_description') || q.get('error');
    close();

    if (token) {
      if (typeof onSuccess === 'function') onSuccess('#' + raw);
      return;
    }
    if (code) {
      if (typeof onSuccess === 'function') onSuccess('?' + raw);
      return;
    }

    let msg = err ? String(err).replace(/\+/g, ' ') : '没有收到登录凭据';
    if (/access_denied|denied/i.test(msg)) msg = '你在浏览器里取消了授权';
    if (typeof onFailure === 'function') onFailure(msg);
  }

  function start(authorizeUrl) {
    if (!authorizeUrl) return false;
    if (authFlow) {
      try { if (typeof onBeforeOpen === 'function') onBeforeOpen(); } catch (_) {}
      try { openExternal(authFlow.url || authorizeUrl); } catch (_) {}
      return true;
    }

    let target;
    try {
      target = new URL(authorizeUrl);
    } catch (_) {
      return false;
    }

    const nonce = crypto.randomBytes(16).toString('hex');
    const callbackHtml = buildCallbackHtml(nonce);
    let expectedOrigin = '';

    const server = http.createServer((req, res) => {
      let pathname = '/';
      try { pathname = new URL(req.url, expectedOrigin || 'http://127.0.0.1').pathname; } catch (_) {}

      if (req.method === 'POST' && pathname === '/payload') {
        const origin = req.headers.origin;
        const reqNonce = String(req.headers['x-pc-auth-nonce'] || '');
        if ((origin && origin !== expectedOrigin) || reqNonce !== nonce) {
          try {
            res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
            res.end('forbidden');
          } catch (_) {}
          return;
        }
        let body = '';
        let aborted = false;
        req.on('data', (chunk) => {
          if (aborted) return;
          body += chunk;
          if (body.length > 65536) {
            aborted = true;
            try { req.destroy(); } catch (_) {}
          }
        });
        req.on('end', () => {
          if (aborted) return;
          try {
            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
            res.end('ok');
          } catch (_) {}
          finish(body);
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/auth-cb') {
        try {
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
          });
          res.end(callbackHtml);
        } catch (_) {}
        return;
      }

      try {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
      } catch (_) {}
    });

    server.on('clientError', (_err, sock) => { try { sock.destroy(); } catch (_) {} });
    server.once('error', () => {
      close();
      try { openExternal(authorizeUrl); } catch (_) {}
    });

    // 直接监听随机空闲端口，消除「先 probe 再 close 再 listen」的 TOCTOU 竞争。
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      if (!port) {
        close();
        if (typeof onFailure === 'function') onFailure('无法启动本地登录回调服务');
        return;
      }
      expectedOrigin = 'http://127.0.0.1:' + port;
      const cbUrl = expectedOrigin + '/auth-cb';
      try { target.searchParams.set('redirect_to', cbUrl); } catch (_) {}
      const finalUrl = target.toString();

      const timer = setTimeout(() => {
        close();
        if (typeof onFailure === 'function') onFailure('等待浏览器登录超时了');
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      authFlow = { server, port, url: finalUrl, nonce, timer };

      try {
        if (typeof onBeforeOpen === 'function') onBeforeOpen();
        openExternal(finalUrl);
        dbg('[auth] 已在系统浏览器打开登录页', finalUrl.slice(0, 80));
      } catch (_) {
        close();
        if (typeof onFailure === 'function') onFailure('打不开系统浏览器');
      }
    });

    return true;
  }

  return {
    start,
    close,
    isActive: () => !!authFlow,
    getFlowInfo: () => (authFlow ? { port: authFlow.port, url: authFlow.url, nonce: authFlow.nonce } : null),
  };
}

module.exports = {
  createAuthBridge,
  buildCallbackHtml,
};
