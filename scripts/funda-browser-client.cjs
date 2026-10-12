'use strict';
const { FundaError } = require('./funda-core.cjs');
function browserClient(origin, token, transport = fetch) {
  const url = new URL(origin);
  if (!token || token.length < 32 || url.username || url.password || url.search || url.hash
    || !(url.protocol === 'https:' && url.hostname.endsWith('.up.railway.app')
      || url.protocol === 'http:' && url.hostname.endsWith('.railway.internal'))) throw new FundaError('BROWSER_CONFIGURATION');
  async function request(path, method = 'GET') {
    let response, result;
    try {
      response = await transport(new URL(path,url), {method,redirect:'error',headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(330000)});
      result = await response.json();
    } catch { throw new FundaError('BROWSER_TRANSPORT'); }
    if (!response.ok) throw new FundaError(/^[A-Z_]{1,60}$/.test(result.category??'') ? result.category : 'BROWSER_STATUS',result.blocked===true);
    return result;
  }
  return {
    state: () => request('/worker/state'),
    recovery: async () => {
      const grant=await request('/worker/recovery','POST');
      let link;try{link=new URL(grant.url)}catch{throw new FundaError('RECOVERY_INVALID')}
      if(!/^[a-f0-9]{32}$/.test(grant.id??'')||link.origin!==url.origin||!/^#key=[A-Za-z0-9_-]{43}$/.test(link.hash))throw new FundaError('RECOVERY_INVALID');
      return grant;
    },
    collect: async () => {
      const result = await request('/worker/collect','POST');
      if (!Array.isArray(result.listings) || !Number.isInteger(result.inspected)) throw new FundaError('BROWSER_RESULT_INVALID');
      return {...result,listings:result.listings.map(item=>({...item,...(item.publishedAt?{publishedAt:new Date(item.publishedAt)}:{})}))};
    },
  };
}
module.exports={browserClient};
