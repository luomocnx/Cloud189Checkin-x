/* eslint-disable no-await-in-loop */
/* cron: 0 7,19 * * *
const $ = new Env('天翼网盘签到'); */

require('dotenv').config();
const log4js = require('log4js');
const { CloudClient } = require('cloud189-sdk');
const { sendNotify } = require('./sendNotify');

// 新增环境变量处理（在日志配置之前）
const EXEC_THRESHOLD = parseInt(process.env.EXEC_THRESHOLD || 1);

// 日志配置
log4js.configure({
  appenders: {
    debug: {
      type: 'console',
      layout: { type: 'pattern', pattern: '%[%d{hh:mm:ss} %p %f{1}:%l%] %m' },
    },
  },
  categories: { default: { appenders: ['debug'], level: 'debug' } },
});
const logger = log4js.getLogger();

// 调试工具
const benchmark = {
  start: Date.now(),
  lap() {
    return `${((Date.now() - this.start) / 1000).toFixed(2)}s`;
  },
};

// 新增工具函数：带超时的 Promise
function timeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`请求超时（${ms}ms）`)), ms)),
  ]);
}

// 核心签到逻辑
async function stressTest(account, familyId, personalCount = 10, familyCount = 10) {
  let personalTotal = 0, familyTotal = 0;
  let actualPersonal = 0, actualFamily = 0;
  const report = [];

  try {
    logger.debug(`🚦 开始压力测试 (账号: ${mask(account.userName || '未知账号')})`);
    const client = new CloudClient(account.userName, account.password);
    await client.login().catch(() => { throw new Error('登录失败'); });
    // 获取初始容量信息
    const userSizeInfo = await client.getUserSizeInfo().catch(() => null);
    
    // 个人签到
    const personalPromises = Array(personalCount).fill().map(() => timeout(client.userSign(), 30000)
      .then((res) => {
        const mb = res.netdiskBonus;
        logger.debug(`[${Date.now()}] 🎯 个人签到 ✅ 获得: ${mb}MB`);
        return mb;
      })
      .catch((err) => {
        const message = err.message.includes('超时') ? `请求超时（30秒）` : err.message;
        report.push(`[${Date.now()}] 🎯 个人签到 ❌ 获得: 0MB (原因: ${message})`);
        return 0;
      }));
    const personalResults = await Promise.allSettled(personalPromises);
    personalTotal = personalResults.reduce((sum, r) => sum + (Number(r.value) || 0), 0);

    // 家庭签到
    const familyPromises = Array(familyCount).fill().map(() => timeout(client.familyUserSign(familyId), 30000)
      .then((res) => {
        const mb = res.bonusSpace;
        logger.debug(`[${Date.now()}] 🏠 家庭签到 ✅ 获得: ${mb}MB`);
        return mb;
      })
      .catch((err) => {
        const message = err.message.includes('超时') ? `请求超时（30秒）` : err.message;
        report.push(`[${Date.now()}] 🏠 家庭签到 ❌ 获得: 0MB (原因: ${message})`);
        return 0;
      }));
    const familyResults = await Promise.allSettled(familyPromises);
    familyTotal = familyResults.reduce((sum, r) => sum + (Number(r.value) || 0), 0);

    // 容量计算
    const afterUserSizeInfo = await client.getUserSizeInfo().catch(() => null);
    try {
      if (userSizeInfo && afterUserSizeInfo) {
        actualPersonal = (afterUserSizeInfo.cloudCapacityInfo.totalSize - userSizeInfo.cloudCapacityInfo.totalSize) / 1048576;
        actualFamily = (afterUserSizeInfo.familyCapacityInfo.totalSize - userSizeInfo.familyCapacityInfo.totalSize) / 1048576;
      }
    } catch (e) {
      logger.error('容量计算错误:', e.message);
    }

    return {
      success: true,
      personalTotal: Number(personalTotal) || 0,
      familyTotal: Number(familyTotal) || 0,
      actualFamily: Number(actualFamily) || 0,
      report: `账号 ${mask(account.userName || '未知账号')}\n${report.join('\n')}`
    };
  } catch (e) {
    return {
      success: false,
      report: `❌ ${mask(account.userName || '未知账号')} 签到失败: ${e.message.split(':')[0]}`,
    };
  }
}

function mask(s) {
  return (s || '未知账号').replace(/(\d{3})\d+(\d{4})/, '$1****$2');
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  try {
    logger.debug('🔥 启动专项压力测试');
    const accounts = require('./accounts');
    const familyId = process.env.FAMILYID;
    if (!familyId) throw new Error('未配置环境变量 FAMILYID');

    // 主账号数据初始化
    let mainAccountData = {
      userName: '未知账号',
      initialPersonal: 0,
      initialFamily: 0,
      finalPersonal: 0,
      finalFamily: 0,
      personalAdded: 0,
      familyAdded: 0
    };

    let mainAccountClient = null;
    let totalFamily = 0, totalActualFamily = 0;
    const reports = [];

    // 处理主账号
    if (accounts.length > 0) {
      try {
        const mainAccount = accounts[0];
        mainAccountClient = new CloudClient(mainAccount.userName, mainAccount.password);
        await mainAccountClient.login();
        
        const initial = await mainAccountClient.getUserSizeInfo().catch(() => null);
        const final = await mainAccountClient.getUserSizeInfo().catch(() => null);
        
        mainAccountData = {
          userName: mask(mainAccount.userName),
          initialPersonal: initial ? initial.cloudCapacityInfo.totalSize / 1048576 : 0,
          initialFamily: initial ? initial.familyCapacityInfo.totalSize / 1048576 : 0,
          finalPersonal: final ? final.cloudCapacityInfo.totalSize / 1048576 : 0,
          finalFamily: final ? final.familyCapacityInfo.totalSize / 1048576 : 0,
          personalAdded: initial && final ? (final.cloudCapacityInfo.totalSize - initial.cloudCapacityInfo.totalSize) / 1048576 : 0,
          familyAdded: initial && final ? (final.familyCapacityInfo.totalSize - initial.familyCapacityInfo.totalSize) / 1048576 : 0
        };
      } catch (e) {
        logger.error('主账号初始化失败:', e.message);
      }
    }

    // 处理所有账号
    for (const [index, account] of accounts.entries()) {
      let personalCount = 10, familyCount = 10;
      if (EXEC_THRESHOLD === 1) {
        personalCount = index === 0 ? 1 : 0;
        familyCount = index === 0 ? 1 : 10;
      } else {
        personalCount = familyCount = EXEC_THRESHOLD;
      }

      const result = await stressTest(account, familyId, personalCount, familyCount);
      if (!result.success) {
        const errorReason = result.report.split(':').pop()?.trim() || '未知错误';
        reports.push({ type: 'error', data: `❌ ${mask(account.userName)}: ${errorReason}` });
        continue;
      }

      totalFamily += result.familyTotal;
      totalActualFamily += result.actualFamily;
      
      if (index !== 0) {
        reports.push({ 
          type: 'sub_account', 
          data: `账号 ${mask(account.userName)} 家庭获得: ${result.familyTotal.toString().padStart(3, ' ')} MB`
        });
      }

      if (accounts.length > 1 && index < accounts.length - 1) {
        await sleep(5000);
      }
    }

    // 构建推送内容
    const format = (value, unit) => {
      const num = unit === 'GB' ? (value / 1024).toFixed(2) : Math.round(value);
      return `${String(num).padStart(unit === 'GB' ? 6 : 3, ' ')} ${unit}`;
    };

    const pushContent = [
      `🏠 所有家庭签到累计获得: ${totalFamily.toString().padStart(3, ' ')} MB`,
      `📈 实际家庭容量总增加: ${totalActualFamily.toFixed(2).padStart(6, ' ')} MB`,
      `⏱️ 执行耗时: ${benchmark.lap()}\n`,
      `🌟 主账号 ${mainAccountData.userName}`,
      `🎯 今日签到获得 | 个人: ${format(mainAccountData.personalAdded, 'MB')} | 家庭: ${format(mainAccountData.familyAdded, 'MB')}`,
      `📊 实际容量增加 | 个人: ${format(mainAccountData.personalAdded, 'MB')} | 家庭: ${format(mainAccountData.familyAdded, 'MB')}`,
      `🏆 今日最终容量 | 个人: ${format(mainAccountData.finalPersonal, 'GB')} | 家庭: ${format(mainAccountData.finalFamily, 'GB')}\n`,
      '📦 其他账号家庭签到：',
      ...reports.filter(r => r.type === 'sub_account').map(r => r.data)
    ].join('\n');

    sendNotify('天翼云盘签到报告', pushContent);
    logger.debug(`📊 最终推送内容:\n${pushContent}`);

  } catch (e) {
    logger.error('全局错误:', e.message);
    process.exit(1);
  }
})();
