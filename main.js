javascript:(async function () {
  'use strict';

  const INTERVAL_MIN = 700;
  const INTERVAL_MAX = 1200;
  const MENU_WAIT = 250;
  const SCROLL_WAIT = 900;
  const MAX_DELETES_DEFAULT = 100;
  const MAX_ITEM_RETRY = 3;
  const MAX_TOTAL_ATTEMPTS_PER_ITEM = 6;
  const MAX_NO_PROGRESS_ROUNDS = 8;
  const RESERVED_PATH_SEGMENTS = new Set([
    'home',
    'explore',
    'notifications',
    'messages',
    'search',
    'settings',
    'i',
    'compose',
    'tos',
    'privacy',
    'login',
    'logout'
  ]);

  let deletedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let attemptedDeleteCount = 0;
  let postDeletedCount = 0;
  let retweetDeletedCount = 0;
  const processedItems = new Set();
  const itemAttemptCounts = new Map();

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForElement(getter, timeoutMs = 2000, intervalMs = 80) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const el = getter();
      if (el) return el;
      await sleep(intervalMs);
    }
    return null;
  }

  async function waitForCondition(checker, timeoutMs = 3000, intervalMs = 100) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (checker()) return true;
      await sleep(intervalMs);
    }
    return false;
  }

  function getPostDate(item) {
    try {
      const timeElement = item.querySelector('time');
      const datetime = timeElement && timeElement.getAttribute('datetime');
      if (datetime) return new Date(datetime);
    } catch (e) {
      console.error('日付取得エラー:', e);
    }
    return null;
  }

  function parseHandleFromPath(pathname) {
    const firstSegment = (pathname || '').split('/').filter(Boolean)[0];
    if (!firstSegment) return null;
    const lower = firstSegment.toLowerCase();
    if (RESERVED_PATH_SEGMENTS.has(lower)) return null;
    if (!/^[A-Za-z0-9_]{1,15}$/.test(firstSegment)) return null;
    return lower;
  }

  function parseHandleFromHref(href) {
    if (!href) return null;
    try {
      const pathname = new URL(href, location.origin).pathname;
      return parseHandleFromPath(pathname);
    } catch (_) {
      return null;
    }
  }

  function inferOwnHandle() {
    const accountSwitcherText =
      document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]')?.innerText || '';
    const sideNavMatch = accountSwitcherText.match(/@([A-Za-z0-9_]{1,15})/);
    if (sideNavMatch) {
      return sideNavMatch[1].toLowerCase();
    }

    const fromPath = parseHandleFromPath(location.pathname);
    if (fromPath) return fromPath;

    const canonical =
      document.querySelector('link[rel="canonical"]')?.getAttribute('href') ||
      document.querySelector('meta[property="og:url"]')?.getAttribute('content');
    return parseHandleFromHref(canonical);
  }

  function getPostAuthorHandle(item) {
    const userNameLinks = Array.from(item.querySelectorAll('[data-testid="User-Name"] a[href]'));
    for (const link of userNameLinks) {
      const handle = parseHandleFromHref(link.getAttribute('href'));
      if (handle) return handle;
    }

    const timeLink = item.querySelector('time')?.closest('a[href]');
    if (timeLink) {
      const handle = parseHandleFromHref(timeLink.getAttribute('href'));
      if (handle) return handle;
    }

    return null;
  }

  function getItemKey(item, fallbackIndex) {
    const statusLink =
      item.querySelector('time')?.closest('a[href*="/status/"]') ||
      item.querySelector('a[href*="/status/"]');
    if (statusLink) {
      return `status:${statusLink.getAttribute('href').split('?')[0]}`;
    }

    const datetime = item.querySelector('time')?.getAttribute('datetime');
    if (datetime) {
      return `time:${datetime}`;
    }

    return `fallback:${fallbackIndex}:${(item.textContent || '').slice(0, 40)}`;
  }

  function findDeleteMenuItem() {
    const menuItems = Array.from(document.querySelectorAll('[role="menuitem"]'));
    return menuItems.find((el) => {
      const text = (el.textContent || '').trim();
      return text === '削除' || text.includes('Delete');
    });
  }

  async function closeMenus() {
    for (let i = 0; i < 3; i++) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(40);
    }
    document.body.click();
    await sleep(100);
  }

  async function deleteRetweetItem(item) {
    const unretweetButton = item.querySelector('[data-testid="unretweet"]');
    if (!unretweetButton) {
      return false;
    }

    unretweetButton.click();
    const confirmButton = await waitForElement(
      () => document.querySelector('[data-testid="unretweetConfirm"]'),
      1800
    );

    if (!confirmButton) {
      await closeMenus();
      return false;
    }

    confirmButton.click();

    const removed = await waitForCondition(() => !item.isConnected, 3200, 100);
    if (removed) return true;

    const switched = await waitForCondition(
      () => !item.querySelector('[data-testid="unretweet"]'),
      1200,
      80
    );

    return switched;
  }

  async function deletePostItem(item) {
    const optionsButton = item.querySelector('[data-testid="caret"]');
    if (!optionsButton) {
      return false;
    }

    optionsButton.click();

    const deleteButton = await waitForElement(findDeleteMenuItem, 1800, 80);
    if (!deleteButton) {
      await closeMenus();
      return false;
    }

    deleteButton.click();

    const confirmButton = await waitForElement(
      () => document.querySelector('[data-testid="confirmationSheetConfirm"]'),
      2200,
      80
    );

    if (!confirmButton) {
      await closeMenus();
      return false;
    }

    confirmButton.click();

    const removed = await waitForCondition(() => !item.isConnected, 3500, 100);
    if (removed) return true;

    const stillVisible = document.body.contains(item);
    return !stillVisible;
  }

  const daysFromInput = prompt(
    '削除する投稿の範囲を設定します。\n\n【何日前から】削除しますか？\n\n例: 30 と入力すると30日前から削除対象になります。\n0 と入力すると今日から削除対象になります。',
    '30'
  );
  if (daysFromInput === null) return;

  const daysFrom = parseInt(daysFromInput, 10);
  if (Number.isNaN(daysFrom) || daysFrom < 0) {
    alert('無効な数値です。処理を中止します。');
    return;
  }

  const daysToInput = prompt(
    `【何日前まで】削除しますか？\n\n例: 90 と入力すると90日前まで削除対象になります。\n9999 と入力するとすべての古い投稿を削除します。\n\n※ ${daysFrom}日前から指定した日数前までの投稿を削除します。`,
    '90'
  );
  if (daysToInput === null) return;

  const daysTo = parseInt(daysToInput, 10);
  if (Number.isNaN(daysTo) || daysTo < 0) {
    alert('無効な数値です。処理を中止します。');
    return;
  }

  if (daysFrom > daysTo) {
    alert('範囲が不正です。「何日前から」の値は「何日前まで」の値より小さくしてください。');
    return;
  }

  const maxDeletesInput = prompt(
    '最大で何件削除しますか？（成功削除の目標件数）\n\n空欄や不正値の場合は 100 件になります。',
    String(MAX_DELETES_DEFAULT)
  );

  let maxDeletes = MAX_DELETES_DEFAULT;
  if (maxDeletesInput !== null && maxDeletesInput.trim() !== '') {
    const parsed = parseInt(maxDeletesInput, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      maxDeletes = parsed;
    }
  }

  const deleteRetweets = confirm(
    'リツイート（リポスト）も削除しますか？\n\n「はい」で通常投稿とRTを削除、「いいえ」で通常投稿のみを削除します。'
  );
  const ownHandle = inferOwnHandle();
  if (!ownHandle) {
    alert(
      '自分のユーザーIDを判定できなかったため、他ユーザー投稿の自動除外は無効です。\nプロフィールページで実行するか、不要な投稿が混ざる場合は画面を切り替えて再実行してください。'
    );
  }

  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - daysFrom);

  const dateTo = new Date();
  dateTo.setDate(dateTo.getDate() - daysTo);

  const statusDiv = document.createElement('div');
  statusDiv.style.cssText =
    'position:fixed;top:10px;right:10px;padding:16px 22px;background-color:#000;color:#fff;z-index:9999;border-radius:4px;font-size:20px;font-weight:bold;font-family:Consolas,Courier New,monospace;letter-spacing:1px;box-shadow:0 4px 20px rgba(0,0,0,0.5);border:2px solid #333;';
  document.body.appendChild(statusDiv);

  function updateStatus(textPrefix = '進行中') {
    statusDiv.textContent = `${textPrefix}: 削除 ${deletedCount}/${maxDeletes} | スキップ ${skippedCount} | 失敗 ${failedCount} | 試行 ${attemptedDeleteCount}`;
  }

  async function processVisibleItems() {
    if (
      document.body.innerText.includes('問題が発生しました') ||
      document.body.innerText.includes('Something went wrong')
    ) {
      alert(
        'Xの制限エラーが検出されたため、処理を中断します。\nしばらく時間をおいてから、ページを再読み込みして再度お試しください。'
      );
      return { continued: false, progressed: false };
    }

    const items = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    if (items.length === 0) {
      alert('投稿が見つかりません。プロフィールページの「投稿」タブで実行してください。');
      return { continued: false, progressed: false };
    }

    let progressed = false;

    for (let i = 0; i < items.length; i++) {
      if (deletedCount >= maxDeletes) {
        return { continued: false, progressed: true };
      }

      const item = items[i];
      const itemKey = getItemKey(item, i);
      if (processedItems.has(itemKey)) {
        continue;
      }

      const postDate = getPostDate(item);
      if (postDate) {
        if (postDate > dateFrom) {
          skippedCount++;
          processedItems.add(itemKey);
          progressed = true;
          continue;
        }
        if (postDate < dateTo) {
          skippedCount++;
          processedItems.add(itemKey);
          progressed = true;
          continue;
        }
      }

      const isRetweet = Boolean(item.querySelector('[data-testid="socialContext"]'));
      if (isRetweet && !deleteRetweets) {
        skippedCount++;
        processedItems.add(itemKey);
        progressed = true;
        continue;
      }

      if (!isRetweet && ownHandle) {
        const authorHandle = getPostAuthorHandle(item);
        if (authorHandle && authorHandle !== ownHandle) {
          skippedCount++;
          processedItems.add(itemKey);
          progressed = true;
          continue;
        }
      }

      const attemptedSoFar = itemAttemptCounts.get(itemKey) || 0;
      const remainingAttempts = MAX_TOTAL_ATTEMPTS_PER_ITEM - attemptedSoFar;
      if (remainingAttempts <= 0) {
        failedCount++;
        processedItems.add(itemKey);
        progressed = true;
        continue;
      }

      let success = false;
      const attemptsThisRound = Math.min(MAX_ITEM_RETRY, remainingAttempts);
      attemptedDeleteCount++;

      for (let attempt = 1; attempt <= attemptsThisRound; attempt++) {
        if (!item.isConnected) break;

        itemAttemptCounts.set(itemKey, (itemAttemptCounts.get(itemKey) || 0) + 1);

        if (isRetweet) {
          success = await deleteRetweetItem(item);
        } else {
          success = await deletePostItem(item);
        }

        if (success) break;

        await closeMenus();
        await sleep(MENU_WAIT);
      }

      progressed = true;

      if (success) {
        processedItems.add(itemKey);
        deletedCount++;
        if (isRetweet) {
          retweetDeletedCount++;
        } else {
          postDeletedCount++;
        }
        const interval = Math.floor(Math.random() * (INTERVAL_MAX - INTERVAL_MIN + 1)) + INTERVAL_MIN;
        console.log(`${deletedCount}件目を削除しました。`);
        updateStatus('削除実行');
        await sleep(interval);
      } else {
        const totalAttempts = itemAttemptCounts.get(itemKey) || 0;
        if (totalAttempts >= MAX_TOTAL_ATTEMPTS_PER_ITEM) {
          processedItems.add(itemKey);
          failedCount++;
          console.log('削除失敗(上限到達): ', itemKey);
          updateStatus('再試行失敗');
        } else {
          console.log('削除失敗(次回再試行): ', itemKey);
          updateStatus('再試行予定');
        }
      }
    }

    return { continued: true, progressed };
  }

  let continueDeleting = true;
  let noProgressRounds = 0;

  updateStatus();

  while (continueDeleting && deletedCount < maxDeletes) {
    const result = await processVisibleItems();
    continueDeleting = result.continued;

    if (!continueDeleting) break;

    const unprocessedVisibleCount = Array.from(
      document.querySelectorAll('article[data-testid="tweet"]')
    ).filter((item, i) => !processedItems.has(getItemKey(item, i))).length;

    if (!result.progressed && unprocessedVisibleCount === 0) {
      noProgressRounds++;
    } else {
      noProgressRounds = 0;
    }

    if (noProgressRounds >= MAX_NO_PROGRESS_ROUNDS) {
      break;
    }

    window.scrollBy(0, Math.floor(window.innerHeight * 0.9));
    await sleep(SCROLL_WAIT);
    updateStatus();
  }

  updateStatus('完了');
  await sleep(4500);
  statusDiv.remove();

  alert(
    `処理が完了しました。\n削除: ${deletedCount}件（通常: ${postDeletedCount} / RT: ${retweetDeletedCount}）\nスキップ: ${skippedCount}件\n失敗: ${failedCount}件\n削除試行: ${attemptedDeleteCount}件\n確定処理: ${deletedCount + skippedCount + failedCount}件\n\n対象範囲: ${daysFrom}日前〜${daysTo}日前\n上限（成功削除目標）: ${maxDeletes}件`
  );
})();
