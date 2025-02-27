/* eslint-disable no-await-in-loop */
/* cron: 0 7,19 * * *
const $ = new Env('天翼网盘签到'); */
require('dotenv').config();
const log4js = require('log4js');
const { CloudClient } = require('cloud189-sdk');
const { sendNotify } = require('./sendNotify');

// 环境变量配置
const EXEC_THRESHOLD = parseInt(process.env.EXEC_THRESHOLD || 1);
const FAMILYID = process.env.FAMILYID;

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

// 工具函数
const benchmark = {
  start: Date.now(),
  lap() {
    return `${((Date.now() - this.start) / 1000).toFixed(2)}s`;
  },
};

function timeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`请求超时（${ms}ms）`)), ms)),
  ]);
}

function mask(s) {
  return s.replace(/(\d{3})\d+(\d{4})/, '$1****$2');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 核心签到逻辑
async function stressTest(account, familyId, personalCount = 10, familyCount = 10) {
  let personalTotal = 0;
  let familyTotal = 0;
  let actualPersonal = 0;
  let actualFamily = 0;
  const report = [];

  try {
    const client = new CloudClient(account.userName, account.password);
    await client.login().catch(() => { throw new Error('登录失败'); });

    const userSizeInfo = await client.getUserSizeInfo().catch(() => null);

    // 个人签到
    const personalPromises = Array(personalCount).fill().map(() => 
      timeout(client.userSign(), 30000)
        .then((res) => {
          report.push(`[个人签到] 获得 ${res.netdiskBonus}MB`);
          return res.netdiskBonus;
        })
        .catch((err) => {
          report.push(`[个人签到] 失败: ${err.message.includes('超时') ? '请求超时' : err.message}`);
          return 0;
        }));
    const personalResults = await Promise.allSettled(personalPromises);
    personalTotal = personalResults.reduce((sum, r) => sum + r.value, 0);

    // 家庭签到
    const familyPromises = Array(familyCount).fill().map(() =>
      timeout(client.familyUserSign(familyId), 30000)
        .then((res) => {
          report.push(`[家庭签到] 获得 ${res.bonusSpace}MB`);
          return res.bonusSpace;
        })
        .catch((err) => {
          report.push(`[家庭签到] 失败: ${err.message.includes('超时') ? '请求超时' : err.message}`);
          return 0;
        }));
    const familyResults = await Promise.allSettled(familyPromises);
    familyTotal = familyResults.reduce((sum, r) => sum + r.value, 0);

    // 容量计算
    const afterUserSizeInfo = await client.getUserSizeInfo().catch(() => null);
    if (userSizeInfo && afterUserSizeInfo) {
      actualPersonal = (afterUserSizeInfo.cloudCapacityInfo.totalSize - userSizeInfo.cloudCapacityInfo.totalSize) / 1024 / 1024;
      actualFamily = (afterUserSizeInfo.familyCapacityInfo.totalSize - userSizeInfo.familyCapacityInfo.totalSize) / 1024 / 1024;
    }

    return {
      success: true,
      personalTotal,
      familyTotal,
      actualPersonal,
      actualFamily,
      report: report.join('\n')
    };
  } catch (e) {
    return {
      success: false,
      report: `❌ 签到失败: ${e.message}`,
      personalTotal: 0,
      familyTotal: 0,
      actualPersonal: 0,
      actualFamily: 0
    };
  }
}

// 主执行逻辑
(async () => {
  try {
    logger.debug('🔥 启动签到任务');
    const accounts = require('./accounts');
    if (!FAMILYID) throw new Error('缺少 FAMILYID 环境变量');

    // 主账号相关变量
    let mainAccountClient = null;
    let initialSizeInfo = null;
    let finalSizeInfo = null;
    let mainAccountFinalSize = { personal: 0, family: 0 };
    let mainAccountData = {
      personalAdded: 0,
      familyAdded: 0,
      actualPersonal: 0,
      actualFamily: 0
    };
    const otherAccounts = [];
    let totalFamily = 0;

    // 处理主账号
    if (accounts.length > 0) {
      const mainAccount = accounts[0];
      mainAccountClient = new CloudClient(mainAccount.userName, mainAccount.password);
      await mainAccountClient.login().catch(e => { throw new Error(`主账号登录失败: ${e.message}`); });
      initialSizeInfo = await mainAccountClient.getUserSizeInfo();
    }

    // 执行签到任务
    for (let index = 0; index < accounts.length; index++) {
      const account = accounts[index];
      const isMainAccount = index === 0;
      
      const personalCount = isMainAccount ? 
        (EXEC_THRESHOLD === 1 ? 1 : EXEC_THRESHOLD) : 0;
      const familyCount = EXEC_THRESHOLD === 1 ? 1 : EXEC_THRESHOLD;

      const result = await stressTest(
        account,
        FAMILYID,
        personalCount,
        familyCount
      );

      if (isMainAccount) {
        mainAccountData = {
          personalAdded: result.personalTotal,
          familyAdded: result.familyTotal,
          actualPersonal: result.actualPersonal,
          actualFamily: result.actualFamily
        };
      } else {
        const familyGain = result.report.match(/\[家庭签到\] 获得 (\d+)MB/)?.[1] || 0;
        otherAccounts.push(`账号 ${mask(account.userName)} 家庭获得: ${familyGain}MB`);
      }

      totalFamily += result.familyTotal;
      if (index < accounts.length - 1) await sleep(5000);
    }

    // 获取最终容量
    if (mainAccountClient) {
      finalSizeInfo = await mainAccountClient.getUserSizeInfo();
      mainAccountFinalSize = {
        personal: (finalSizeInfo.cloudCapacityInfo.totalSize / 1024 / 1024).toFixed(2),
        family: (finalSizeInfo.familyCapacityInfo.totalSize / 1024 / 1024).toFixed(2)
      };
    }

    // 构建通知内容
    const report = [
      `🏠 所有家庭签到累计获得: ${totalFamily}MB`,
      `📈 实际家庭容量总增加: ${mainAccountData.actualFamily.toFixed(2)}MB`,
      `⏱️ 执行耗时: ${benchmark.lap()}`,
      '',
      `🌟 主账号 ${mask(accounts[0].userName)}`,
      `🎯 今日签到获得 | 个人: ${mainAccountData.personalAdded.toFixed(2)}MB | 家庭: ${mainAccountData.familyAdded.toFixed(2)}MB`,
      `📊 实际容量增加 | 个人: ${mainAccountData.actualPersonal.toFixed(2)}MB | 家庭: ${mainAccountData.actualFamily.toFixed(2)}MB`,
      `🏆 今日最终容量 | 个人: ${mainAccountFinalSize.personal}MB | 家庭: ${mainAccountFinalSize.family}MB`,
      '',
      '📦 其他账号家庭签到：',
      ...otherAccounts
    ].join('\n');

    sendNotify('天翼云签到报告', report);
    logger.info('\n' + report);

  } catch (e) {
    logger.error('执行失败:', e.message);
    sendNotify('天翼云签到异常', `❌ 运行失败: ${e.message}`);
    process.exit(1);
  }
})();
