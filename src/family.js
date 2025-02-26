/* eslint-disable no-await-in-loop */
/* cron: 0 7,19 * * *
const $ = new Env('天翼网盘签到'); */
require('dotenv').config();
const log4js = require('log4js');
const { CloudClient } = require('cloud189-sdk');
const { sendNotify } = require('./sendNotify');

// 新增环境变量处理（在日志配置之前）
const EXEC_THRESHOLD = parseInt(process.env.EXEC_THRESHOLD || 1); // 默认值为1

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
async function stressTest(account, familyId, personalCount = 10, familyCount = 10, isMainAccount = false) {
  let personalTotal = 0;
  let familyTotal = 0;
  let actualPersonal = 0;
  let actualFamily = 0;
  const report = [];

  try {
    logger.debug(`🚦 开始压力测试 (账号: ${mask(account.userName)})`);

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
    personalTotal = personalResults.reduce((sum, r) => sum + r.value, 0);
    report.push(`🎯 个人签到完成 累计获得: ${personalTotal}MB`);

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
    familyTotal = familyResults.reduce((sum, r) => sum + r.value, 0);
    report.push(`🏠 家庭签到完成 本次获得: ${familyTotal}MB`);

    // 获取签到后容量信息
    const afterUserSizeInfo = await client.getUserSizeInfo().catch(() => null);

    // 计算实际容量变化
    if (userSizeInfo && afterUserSizeInfo) {
      actualPersonal = (afterUserSizeInfo.cloudCapacityInfo.totalSize - userSizeInfo.cloudCapacityInfo.totalSize) / 1024 / 1024;
      actualFamily = (afterUserSizeInfo.familyCapacityInfo.totalSize - userSizeInfo.familyCapacityInfo.totalSize) / 1024 / 1024;
      report.push(`📊 实际容量变化 | 个人: ${actualPersonal.toFixed(2)}MB | 家庭: ${actualFamily.toFixed(2)}MB`);
    } else {
      report.push(`⚠️ 容量信息获取失败，无法计算实际变化`);
    }

    // 返回完整报告或简化报告
    if (isMainAccount) {
      return {
        success: true,
        personalTotal,
        familyTotal,
        actualFamily,
        report: `账号 ${mask(account.userName)}\n${report.join('\n')}`,
      };
    } else {
      return {
        success: true,
        personalTotal,
        familyTotal,
        actualFamily,
        report: `账号 ${mask(account.userName)}\n${report.join('\n')}`,
      };
    }
  } catch (e) {
    return {
      success: false,
      report: `❌ ${mask(account.userName)} 签到失败: ${e.message}`,
    };
  }
}

// 辅助方法
function mask(s) {
  return s.replace(/(\d{3})\d+(\d{4})/, '$1****$2');
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 修改后的执行测试
(async () => {
  try {
    const accounts = require('./accounts');
    const familyId = process.env.FAMILYID;

    if (!familyId) throw new Error('未配置环境变量 FAMILYID');

    let mainAccountClient = null;
    let initialSizeInfo = null;

    if (accounts.length > 0) {
      mainAccountClient = new CloudClient(accounts[0].userName, accounts[0].password);
      await mainAccountClient.login();
      initialSizeInfo = await mainAccountClient.getUserSizeInfo();
      logger.debug(`🏠 初始家庭容量: ${initialSizeInfo.familyCapacityInfo.totalSize} Bytes`);
    }

    const reports = [];
    let totalFamily = 0;

    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      const isMainAccount = i === 0;
      const personalCount = isMainAccount ? 1 : 0;
      const familyCount = isMainAccount ? 1 : 10;

      const result = await stressTest(
        { userName: account.userName, password: account.password },
        familyId,
        personalCount,
        familyCount,
        isMainAccount
      );

      // 如果是主账号，直接添加完整报告
      if (isMainAccount) {
        reports.push(result.report);
      } else {
        // 如果是副账号，去掉报告末尾的换行符
        reports.push(result.report.trim());
      }

      if (result.success) totalFamily += result.familyTotal;
    }

    const finalSizeInfo = await mainAccountClient.getUserSizeInfo();
    const actualFamilyTotal = (finalSizeInfo.familyCapacityInfo.totalSize - initialSizeInfo.familyCapacityInfo.totalSize) / 1024 / 1024;

    // 构造统计信息
    const summary = [
      `🏠 所有家庭签到累计获得: ${totalFamily}MB`,
      `📈 实际家庭容量总增加: ${actualFamilyTotal.toFixed(2)}MB`,
      `⏱️ 执行耗时: ${benchmark.lap()}`
    ].join('\n');

    // 构造完整报告（统计信息在最前面）
    const finalReport = [summary, ...reports].join('\n\n');

    // 推送完整报告
    sendNotify('', finalReport);
  } catch (e) {
    logger.error('致命错误:', e.message);
  }
})();
