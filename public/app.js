(() => {
  "use strict";

  // --- ログインユーザー情報・ログアウト ---
  const userDisplayNameEl = document.getElementById("user-display-name");
  const logoutBtn = document.getElementById("logout-btn");
  let currentUser = null;

  function renderUser(user) {
    currentUser = user;
    if (user) userDisplayNameEl.textContent = `${user.displayName} さん`;
    const adminTabBtn = document.getElementById("admin-tab-btn");
    if (adminTabBtn) adminTabBtn.classList.toggle("hidden", !(user && user.isAdmin));
  }

  async function loadSession() {
    try {
      const res = await fetch("/api/session");
      if (!res.ok) return;
      const data = await res.json();
      if (data.user) renderUser(data.user);
    } catch (err) {
      // 無視（表示できなくてもアプリ自体は使える）
    }
  }
  loadSession();

  logoutBtn.addEventListener("click", async () => {
    await fetch("/auth/logout", { method: "POST" });
    window.location.href = "/login.html";
  });

  // --- タブ切り替え ---
  const tabButtons = document.querySelectorAll(".tab-btn");
  const tabPanels = document.querySelectorAll(".tab-panel");

  function activateTab(name) {
    tabButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === name));
    tabPanels.forEach((panel) => panel.classList.toggle("active", panel.id === `tab-${name}`));
    if (name === "history") loadHistory();
    if (name === "account") {
      displayNameInput.value = currentUser ? currentUser.displayName : "";
      playFadeInSequence(Array.from(document.querySelectorAll("#tab-account .card")));
    }
    if (name === "about") {
      playFadeInSequence(Array.from(document.querySelectorAll("#tab-about .card")));
    }
    if (name === "admin") {
      loadAdminAccounts();
      playFadeInSequence(Array.from(document.querySelectorAll("#tab-admin .card")));
    }
    if (name === "banned") {
      loadHeadingStructure();
      loadBannedWords();
      loadStyleNotes();
      loadMyExamples();
      playFadeInSequence(Array.from(document.querySelectorAll("#tab-banned .card")));
    }
    if (name === "generate") {
      playFadeInSequence([
        ...document.querySelectorAll("#tab-generate .generate-input .card"),
        resultCardEl,
        copyBtn,
      ]);
    }
  }

  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => activateTab(btn.dataset.tab));
  });

  // --- 生成タブ ---
  const memoEl = document.getElementById("memo");
  const nameEl = document.getElementById("name");
  const ageEl = document.getElementById("age");
  const occupationEl = document.getElementById("occupation");
  const heightEl = document.getElementById("height");
  const weightEl = document.getElementById("weight");
  const bustEl = document.getElementById("bust");
  const typeEl = document.getElementById("type");
  const impressionEl = document.getElementById("impression");
  const includeConcernsEl = document.getElementById("include-concerns");
  const generateBtn = document.getElementById("generate-btn");
  const generateStatus = document.getElementById("generate-status");
  const genProgressEl = document.getElementById("gen-progress");
  const genProgressBarEl = document.getElementById("gen-progress-bar");
  const resultEl = document.getElementById("result");
  const copyBtn = document.getElementById("copy-btn");
  const copyBtnTop = document.getElementById("copy-btn-top");
  const warningsEl = document.getElementById("warnings");
  const memoCharCountEl = document.getElementById("memo-char-count");
  const resultCharCountEl = document.getElementById("result-char-count");
  const consistencyWarningsEl = document.getElementById("consistency-warnings");
  const consistencyWarningsListEl = document.getElementById("consistency-warnings-list");
  const recommendCardEl = document.getElementById("recommend-card");
  const recommendationEl = document.getElementById("recommendation");
  const copyBtnRecommend = document.getElementById("copy-btn-recommend");
  const auroraIconWrapEl = document.getElementById("aurora-icon-wrap");
  const resultTitleEl = document.getElementById("result-title");
  const resultCardEl = document.getElementById("result-card");

  function playFadeInSequence(elements, options = {}) {
    const stagger = options.stagger ?? 90;
    const maxDelay = options.maxDelay ?? 600;
    const visible = elements.filter((el) => el && !el.classList.contains("hidden"));
    visible.forEach((el, i) => {
      el.classList.remove("fade-in-card");
      void el.offsetWidth;
      el.style.animationDelay = `${Math.min(i * stagger, maxDelay)}ms`;
      el.classList.add("fade-in-card");
    });
  }

  // 実際の生成時間はサーバーからの逐次進捗が取れないため、典型的な所要時間(約16秒)を
  // 目安にゆっくり90%まで近づける「見立ての進捗」。完了時に即100%へスナップする。
  function startFakeProgress() {
    genProgressEl.classList.remove("hidden");
    genProgressBarEl.style.transition = "none";
    genProgressBarEl.style.width = "0%";
    void genProgressBarEl.offsetWidth;
    genProgressBarEl.style.transition = "width 16s cubic-bezier(0.1, 0.6, 0.2, 1)";
    setTimeout(() => {
      genProgressBarEl.style.width = "90%";
    }, 20);
  }

  function finishFakeProgress() {
    genProgressBarEl.style.transition = "width 0.4s ease";
    genProgressBarEl.style.width = "100%";
    setTimeout(() => {
      genProgressEl.classList.add("hidden");
      genProgressBarEl.style.transition = "none";
      genProgressBarEl.style.width = "0%";
    }, 500);
  }

  const INCLUDE_CONCERNS_STORAGE_KEY = "auria:include-concerns";
  includeConcernsEl.checked = localStorage.getItem(INCLUDE_CONCERNS_STORAGE_KEY) === "1";
  includeConcernsEl.addEventListener("change", () => {
    localStorage.setItem(INCLUDE_CONCERNS_STORAGE_KEY, includeConcernsEl.checked ? "1" : "0");
  });

  function updateMemoCharCount() {
    memoCharCountEl.textContent = `${memoEl.value.length}文字`;
  }
  memoEl.addEventListener("input", updateMemoCharCount);
  updateMemoCharCount();

  // 外部サービス（CRM等）からURLパラメータ経由で基本情報・面接メモを渡された場合、
  // 各入力欄に自動で反映する（例: ?name=...&memo=...&age=...）。
  function prefillFromQueryParams() {
    const params = new URLSearchParams(window.location.search);
    if (![...params.keys()].length) return;
    const fieldMap = {
      name: nameEl,
      memo: memoEl,
      age: ageEl,
      occupation: occupationEl,
      height: heightEl,
      weight: weightEl,
      bust: bustEl,
      type: typeEl,
      impression: impressionEl,
    };
    for (const [key, el] of Object.entries(fieldMap)) {
      const value = params.get(key);
      if (value !== null && el) el.value = value;
    }
    updateMemoCharCount();
    window.history.replaceState({}, "", window.location.pathname);
  }
  prefillFromQueryParams();

  // 生成結果の利用状況計測（コピー・編集の有無。アプリ画面には表示せず、必要なときにDBを直接確認する）
  let trackedRecordId = null;
  let trackedOriginalOutput = "";
  let trackedEditReported = false;

  function reportHistoryUsage(kind) {
    if (!trackedRecordId) return;
    fetch(`/api/history/${trackedRecordId}/${kind}`, { method: "POST" }).catch(() => {});
  }

  resultEl.addEventListener("input", () => {
    resultCharCountEl.textContent = resultEl.value ? `${resultEl.value.length}文字` : "";
    if (!trackedEditReported && resultEl.value !== trackedOriginalOutput) {
      trackedEditReported = true;
      reportHistoryUsage("edited");
    }
  });

  function renderGeneratedResult(data, statusText) {
    resultEl.value = data.output || "";
    resultCharCountEl.textContent = data.output ? `${data.output.length}文字` : "";
    copyBtn.disabled = !data.output;
    copyBtnTop.disabled = !data.output;
    generateStatus.textContent = statusText;

    trackedRecordId = data.id || null;
    trackedOriginalOutput = data.output || "";
    trackedEditReported = false;

    if (data.recommendation) {
      recommendationEl.value = data.recommendation;
      recommendCardEl.classList.remove("hidden");
    } else {
      recommendationEl.value = "";
      recommendCardEl.classList.add("hidden");
    }

    const warnings = [];
    if (data.bannedHits && data.bannedHits.length > 0) {
      warnings.push(`禁止ワードの可能性: ${data.bannedHits.join(", ")}`);
    }
    if (data.missingHeadings && data.missingHeadings.length > 0) {
      warnings.push(`見出しが不足している可能性: ${data.missingHeadings.join(", ")}`);
    }
    if (data.closingRepetition) {
      warnings.push(`【最後に】で「お待ちしております」等が重複している可能性があります`);
    }
    if (data.missingRecommendation) {
      warnings.push(`「おすすめの男性像」が生成されませんでした`);
    }
    if (warnings.length > 0) {
      warningsEl.innerHTML = warnings.map((w) => `<div>⚠ ${escapeHtml(w)}</div>`).join("");
      warningsEl.classList.remove("hidden");
    } else {
      warningsEl.innerHTML = "";
      warningsEl.classList.add("hidden");
    }

    if (data.consistencyWarnings && data.consistencyWarnings.length > 0) {
      consistencyWarningsListEl.innerHTML = data.consistencyWarnings
        .map((w) => `<li>${escapeHtml(w)}</li>`)
        .join("");
      consistencyWarningsEl.classList.remove("hidden");
    } else {
      consistencyWarningsListEl.innerHTML = "";
      consistencyWarningsEl.classList.add("hidden");
    }

    playFadeInSequence([consistencyWarningsEl, resultCardEl, copyBtn, recommendCardEl]);
  }

  async function generate() {
    const memo = memoEl.value.trim();
    const name = nameEl.value.trim();
    if (!memo) {
      generateStatus.textContent = "面接メモを入力してください。";
      return;
    }
    if (!name) {
      generateStatus.textContent = "会員の呼び名を入力してください。";
      return;
    }

    generateBtn.disabled = true;
    generateStatus.textContent = "生成しています...";
    warningsEl.classList.add("hidden");
    warningsEl.innerHTML = "";
    consistencyWarningsEl.classList.add("hidden");
    consistencyWarningsListEl.innerHTML = "";
    recommendCardEl.classList.add("hidden");
    recommendationEl.value = "";
    resultEl.value = "";
    resultCharCountEl.textContent = "";
    copyBtn.disabled = true;
    copyBtnTop.disabled = true;
    if (auroraIconWrapEl) auroraIconWrapEl.classList.add("generating");
    if (resultTitleEl) resultTitleEl.textContent = "生成中...";
    startFakeProgress();

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          memo,
          name,
          age: ageEl.value.trim() || null,
          occupation: occupationEl.value.trim() || null,
          height: heightEl.value.trim() || null,
          weight: weightEl.value.trim() || null,
          bust: bustEl.value.trim() || null,
          type: typeEl.value || null,
          impression: impressionEl.value.trim() || null,
          includeConcerns: includeConcernsEl.checked,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "生成に失敗しました。");

      renderGeneratedResult(data, `完了 (model: ${data.model})`);
    } catch (err) {
      generateStatus.textContent = `エラー: ${err.message}`;
    } finally {
      generateBtn.disabled = false;
      if (auroraIconWrapEl) auroraIconWrapEl.classList.remove("generating");
      if (resultTitleEl) resultTitleEl.textContent = "生成結果";
      finishFakeProgress();
    }
  }

  generateBtn.addEventListener("click", generate);

  const clearAllBtn = document.getElementById("clear-all-btn");
  clearAllBtn.addEventListener("click", () => {
    memoEl.value = "";
    nameEl.value = "";
    ageEl.value = "";
    occupationEl.value = "";
    heightEl.value = "";
    weightEl.value = "";
    bustEl.value = "";
    typeEl.value = "";
    impressionEl.value = "";
    updateMemoCharCount();

    warningsEl.classList.add("hidden");
    warningsEl.innerHTML = "";
    consistencyWarningsEl.classList.add("hidden");
    consistencyWarningsListEl.innerHTML = "";
    recommendCardEl.classList.add("hidden");
    recommendationEl.value = "";
    resultEl.value = "";
    resultCharCountEl.textContent = "";
    copyBtn.disabled = true;
    copyBtnTop.disabled = true;
    generateStatus.textContent = "";
    if (resultTitleEl) resultTitleEl.textContent = "生成結果";

    trackedRecordId = null;
    trackedOriginalOutput = "";
    trackedEditReported = false;
  });

  async function copyResult(btn, sourceEl, label, doneLabel) {
    const labelEl = btn.querySelector(".btn-label");
    try {
      await navigator.clipboard.writeText(sourceEl.value);
      labelEl.textContent = doneLabel;
    } catch (err) {
      labelEl.textContent = "コピー失敗";
    }
    setTimeout(() => (labelEl.textContent = label), 1500);
  }

  copyBtn.addEventListener("click", () => {
    copyResult(copyBtn, resultEl, "コピーする", "コピーしました");
    reportHistoryUsage("copied");
  });
  copyBtnTop.addEventListener("click", () => {
    copyResult(copyBtnTop, resultEl, "コピー", "コピーしました");
    reportHistoryUsage("copied");
  });
  copyBtnRecommend.addEventListener("click", () =>
    copyResult(copyBtnRecommend, recommendationEl, "コピー", "コピーしました")
  );

  // --- 履歴タブ ---
  const historyItemsEl = document.getElementById("history-items");
  const historyRefreshBtn = document.getElementById("history-refresh");
  const historyDetailEmpty = document.getElementById("history-detail-empty");
  const historyDetailContent = document.getElementById("history-detail-content");
  const historyDetailTitle = document.getElementById("history-detail-title");
  const historyDetailDate = document.getElementById("history-detail-date");
  const historyDetailMeta = document.getElementById("history-detail-meta");
  const historyDetailMemo = document.getElementById("history-detail-memo");
  const historyDetailImpressionLabel = document.getElementById("history-detail-impression-label");
  const historyDetailImpression = document.getElementById("history-detail-impression");
  const historyDetailOutput = document.getElementById("history-detail-output");
  const historyDetailRecommendLabel = document.getElementById("history-detail-recommend-label");
  const historyDetailRecommendation = document.getElementById("history-detail-recommendation");
  const historyDetailConsistency = document.getElementById("history-detail-consistency");
  const historyDetailConsistencyList = document.getElementById("history-detail-consistency-list");
  const historyReuseBtn = document.getElementById("history-reuse-btn");

  let currentHistoryRecord = null;

  function formatHistoryGroupLabel(d) {
    const now = new Date();
    const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
    if (diffDays === 0) return "今日";
    if (diffDays === 1) return "昨日";
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }

  function formatHistoryTime(d) {
    return d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
  }

  async function loadHistory() {
    historyItemsEl.innerHTML = "<li class=\"muted\">読み込み中...</li>";
    try {
      const res = await fetch("/api/history");
      const items = await res.json();
      if (items.length === 0) {
        historyItemsEl.innerHTML = "<li class=\"muted\">履歴はまだありません</li>";
        return;
      }
      historyItemsEl.innerHTML = "";
      let lastGroupLabel = null;
      items.forEach((item, index) => {
        const createdAt = new Date(item.createdAt);
        const groupLabel = formatHistoryGroupLabel(createdAt);
        if (groupLabel !== lastGroupLabel) {
          const header = document.createElement("li");
          header.className = "history-date-header";
          header.textContent = groupLabel;
          historyItemsEl.appendChild(header);
          lastGroupLabel = groupLabel;
        }

        const li = document.createElement("li");
        li.className = "history-item";
        const typeBadge = item.type ? `<span class="type-badge">${escapeHtml(item.type)}</span>` : "";
        li.innerHTML = `
          <div class="top-row">
            <span class="name">${escapeHtml(item.name)}さん</span>
            ${typeBadge}
            <span class="time">${formatHistoryTime(createdAt)}</span>
          </div>
          <p class="preview-text">${escapeHtml(item.preview || "")}</p>
        `;
        li.addEventListener("click", () => selectHistory(item.id, li));
        historyItemsEl.appendChild(li);

        if (index === 0) {
          selectHistory(item.id, li);
        }
      });

      playFadeInSequence(Array.from(historyItemsEl.children), { stagger: 50, maxDelay: 500 });
    } catch (err) {
      historyItemsEl.innerHTML = `<li class="muted">読み込みエラー: ${escapeHtml(err.message)}</li>`;
    }
  }

  async function selectHistory(id, liEl) {
    document.querySelectorAll(".history-list li.history-item").forEach((li) => li.classList.remove("selected"));
    if (liEl) liEl.classList.add("selected");

    const res = await fetch(`/api/history/${encodeURIComponent(id)}`);
    if (!res.ok) return;
    const record = await res.json();
    currentHistoryRecord = record;

    historyDetailEmpty.classList.add("hidden");
    historyDetailContent.classList.remove("hidden");
    historyDetailTitle.textContent = `${record.name}さん`;
    historyDetailDate.textContent = formatDate(record.createdAt);
    const metaParts = [];
    if (record.age) metaParts.push(`${record.age}歳`);
    if (record.occupation) metaParts.push(record.occupation);
    if (record.height) metaParts.push(`身長 ${record.height}cm`);
    if (record.weight) metaParts.push(`体重 ${record.weight}kg`);
    if (record.bust) metaParts.push(`バスト ${record.bust}`);
    if (record.type) metaParts.push(`交際タイプ ${record.type}`);
    historyDetailMeta.textContent = metaParts.join(" / ");
    historyDetailMemo.value = record.memo;
    historyDetailOutput.value = record.output;

    if (record.impression) {
      historyDetailImpression.value = record.impression;
      historyDetailImpression.classList.remove("hidden");
      historyDetailImpressionLabel.classList.remove("hidden");
    } else {
      historyDetailImpression.classList.add("hidden");
      historyDetailImpressionLabel.classList.add("hidden");
    }

    if (record.recommendation) {
      historyDetailRecommendation.value = record.recommendation;
      historyDetailRecommendation.classList.remove("hidden");
      historyDetailRecommendLabel.classList.remove("hidden");
    } else {
      historyDetailRecommendation.classList.add("hidden");
      historyDetailRecommendLabel.classList.add("hidden");
    }

    if (record.consistencyWarnings && record.consistencyWarnings.length > 0) {
      historyDetailConsistencyList.innerHTML = record.consistencyWarnings
        .map((w) => `<li>${escapeHtml(w)}</li>`)
        .join("");
      historyDetailConsistency.classList.remove("hidden");
    } else {
      historyDetailConsistency.classList.add("hidden");
    }
  }

  historyRefreshBtn.addEventListener("click", loadHistory);

  historyReuseBtn.addEventListener("click", () => {
    if (!currentHistoryRecord) return;
    memoEl.value = currentHistoryRecord.memo;
    nameEl.value = currentHistoryRecord.name;
    ageEl.value = currentHistoryRecord.age || "";
    occupationEl.value = currentHistoryRecord.occupation || "";
    heightEl.value = currentHistoryRecord.height || "";
    weightEl.value = currentHistoryRecord.weight || "";
    bustEl.value = currentHistoryRecord.bust || "";
    typeEl.value = currentHistoryRecord.type || "";
    impressionEl.value = currentHistoryRecord.impression || "";
    updateMemoCharCount();
    renderGeneratedResult(
      currentHistoryRecord,
      `履歴から復元しました (${formatDate(currentHistoryRecord.createdAt)})`
    );
    activateTab("generate");
  });

  // --- コメント構成のカスタマイズ ---
  const headingListEl = document.getElementById("heading-structure-list");
  const headingNewNameEl = document.getElementById("heading-new-name");
  const headingNewGuidanceEl = document.getElementById("heading-new-guidance");
  const headingAddBtn = document.getElementById("heading-add-btn");
  const headingAddStatus = document.getElementById("heading-add-status");
  const headingSaveBtn = document.getElementById("heading-save-btn");
  const headingResetBtn = document.getElementById("heading-reset-btn");
  const headingStatus = document.getElementById("heading-status");
  const MAX_CUSTOM_HEADINGS = 5;
  let headingStructureState = [];

  function renderHeadingStructureList() {
    headingListEl.innerHTML = headingStructureState
      .map((h, i) => {
        const isFirst = i === 0;
        const isLast = i === headingStructureState.length - 1;
        const guidanceBlock = h.custom
          ? `<textarea class="heading-guidance-input" data-index="${i}" rows="2" placeholder="この見出しに書く内容の指示">${escapeHtml(
              h.guidance || ""
            )}</textarea>`
          : "";
        return `
          <li class="heading-structure-item${h.enabled ? "" : " disabled"}">
            <div class="heading-structure-row">
              <button type="button" class="heading-move-btn" data-index="${i}" data-dir="up" ${
          isFirst ? "disabled" : ""
        }>↑</button>
              <button type="button" class="heading-move-btn" data-index="${i}" data-dir="down" ${
          isLast ? "disabled" : ""
        }>↓</button>
              <label class="heading-enable-toggle">
                <input type="checkbox" class="heading-enable-input" data-index="${i}" ${
          h.enabled ? "checked" : ""
        }>
                <span>${escapeHtml(h.key)}</span>
                ${h.custom ? '<span class="heading-custom-tag">（独自）</span>' : ""}
              </label>
              ${h.custom ? `<button type="button" class="heading-delete-btn" data-index="${i}">削除</button>` : ""}
            </div>
            ${guidanceBlock}
          </li>
        `;
      })
      .join("");
  }

  async function loadHeadingStructure() {
    headingStatus.textContent = "読み込み中...";
    try {
      const res = await fetch("/api/heading-structure");
      const data = await res.json();
      headingStructureState = data.headings;
      renderHeadingStructureList();
      headingStatus.textContent = data.isCustomized ? "" : "（現在: 標準構成）";
    } catch (err) {
      headingStatus.textContent = `読み込みエラー: ${err.message}`;
    }
  }

  headingListEl.addEventListener("click", (e) => {
    const moveBtn = e.target.closest(".heading-move-btn");
    if (moveBtn) {
      const i = Number(moveBtn.dataset.index);
      const j = moveBtn.dataset.dir === "up" ? i - 1 : i + 1;
      if (j < 0 || j >= headingStructureState.length) return;
      [headingStructureState[i], headingStructureState[j]] = [headingStructureState[j], headingStructureState[i]];
      renderHeadingStructureList();
      return;
    }
    const delBtn = e.target.closest(".heading-delete-btn");
    if (delBtn) {
      const i = Number(delBtn.dataset.index);
      headingStructureState.splice(i, 1);
      renderHeadingStructureList();
    }
  });

  headingListEl.addEventListener("change", (e) => {
    if (e.target.classList.contains("heading-enable-input")) {
      const i = Number(e.target.dataset.index);
      headingStructureState[i].enabled = e.target.checked;
    }
  });

  headingListEl.addEventListener("input", (e) => {
    if (e.target.classList.contains("heading-guidance-input")) {
      const i = Number(e.target.dataset.index);
      headingStructureState[i].guidance = e.target.value;
    }
  });

  headingAddBtn.addEventListener("click", () => {
    const name = headingNewNameEl.value.trim();
    if (!name) {
      headingAddStatus.textContent = "見出し名を入力してください。";
      return;
    }
    const customCount = headingStructureState.filter((h) => h.custom).length;
    if (customCount >= MAX_CUSTOM_HEADINGS) {
      headingAddStatus.textContent = `独自の見出しは最大${MAX_CUSTOM_HEADINGS}個までです。`;
      return;
    }
    let key = name;
    if (!key.startsWith("【")) key = `【${key}`;
    if (!key.endsWith("】")) key = `${key}】`;
    if (key === "【懸念点】") {
      headingAddStatus.textContent = "「【懸念点】」は生成画面のチェックボックスで別途ON/OFFします。";
      return;
    }
    if (headingStructureState.some((h) => h.key === key)) {
      headingAddStatus.textContent = "すでに同じ名前の見出しがあります。";
      return;
    }
    headingStructureState.push({ key, custom: true, enabled: true, guidance: headingNewGuidanceEl.value.trim() });
    renderHeadingStructureList();
    headingNewNameEl.value = "";
    headingNewGuidanceEl.value = "";
    headingAddStatus.textContent = "追加しました（「変更を保存」を押すと確定します）。";
  });

  headingSaveBtn.addEventListener("click", async () => {
    headingStatus.textContent = "保存しています...";
    try {
      const res = await fetch("/api/heading-structure", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ headings: headingStructureState }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "保存に失敗しました。");
      headingStructureState = data.headings;
      renderHeadingStructureList();
      headingStatus.textContent = "保存しました。";
    } catch (err) {
      headingStatus.textContent = `エラー: ${err.message}`;
    }
  });

  headingResetBtn.addEventListener("click", async () => {
    headingStatus.textContent = "標準構成に戻しています...";
    try {
      const res = await fetch("/api/heading-structure", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ headings: [] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "失敗しました。");
      headingStructureState = data.headings;
      renderHeadingStructureList();
      headingStatus.textContent = "標準構成に戻しました。";
    } catch (err) {
      headingStatus.textContent = `エラー: ${err.message}`;
    }
  });

  // --- 禁止ワード管理タブ ---
  const bannedRawEl = document.getElementById("banned-raw");
  const bannedSaveBtn = document.getElementById("banned-save-btn");
  const bannedReloadBtn = document.getElementById("banned-reload-btn");
  const bannedStatus = document.getElementById("banned-status");
  const bannedPreviewEl = document.getElementById("banned-preview");

  function renderBannedPreview(raw) {
    const words = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    bannedPreviewEl.innerHTML = words.length
      ? words.map((w) => `<span class="chip">${escapeHtml(w)}</span>`).join("")
      : '<span class="muted">単語がありません</span>';
  }

  async function loadBannedWords() {
    bannedStatus.textContent = "読み込み中...";
    try {
      const res = await fetch("/api/banned-words");
      const data = await res.json();
      bannedRawEl.value = data.raw;
      renderBannedPreview(data.raw);
      bannedStatus.textContent = "";
    } catch (err) {
      bannedStatus.textContent = `読み込みエラー: ${err.message}`;
    }
  }

  bannedRawEl.addEventListener("input", () => renderBannedPreview(bannedRawEl.value));

  bannedSaveBtn.addEventListener("click", async () => {
    bannedStatus.textContent = "保存しています...";
    try {
      const res = await fetch("/api/banned-words", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw: bannedRawEl.value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "保存に失敗しました。");
      bannedStatus.textContent = "保存しました。";
    } catch (err) {
      bannedStatus.textContent = `エラー: ${err.message}`;
    }
  });

  bannedReloadBtn.addEventListener("click", loadBannedWords);

  // --- 自分の紹介文サンプル ---
  const myExampleTitleEl = document.getElementById("my-example-title");
  const myExampleContentEl = document.getElementById("my-example-content");
  const myExampleAddBtn = document.getElementById("my-example-add-btn");
  const myExampleStatus = document.getElementById("my-example-status");
  const myExampleListEl = document.getElementById("my-example-list");

  async function loadMyExamples() {
    try {
      const res = await fetch("/api/examples/personal");
      const items = await res.json();
      myExampleListEl.innerHTML = "";
      if (items.length === 0) {
        myExampleListEl.innerHTML = '<li class="muted">まだ登録されていません</li>';
        return;
      }
      items.forEach((item) => {
        const li = document.createElement("li");
        const titlePart = item.title ? `<span class="my-example-title">${escapeHtml(item.title)}</span>` : "";
        li.innerHTML = `<span class="my-example-text">${titlePart}${escapeHtml(item.preview)}</span><button>削除</button>`;
        li.querySelector("button").addEventListener("click", async () => {
          await fetch(`/api/examples/personal/${encodeURIComponent(item.id)}`, { method: "DELETE" });
          loadMyExamples();
        });
        myExampleListEl.appendChild(li);
      });
    } catch (err) {
      myExampleListEl.innerHTML = `<li class="muted">読み込みエラー: ${escapeHtml(err.message)}</li>`;
    }
  }

  myExampleAddBtn.addEventListener("click", async () => {
    const content = myExampleContentEl.value.trim();
    if (!content) {
      myExampleStatus.textContent = "本文を入力してください。";
      return;
    }
    myExampleStatus.textContent = "追加しています...";
    try {
      const res = await fetch("/api/examples/personal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: myExampleTitleEl.value.trim(), content }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "追加に失敗しました。");
      myExampleTitleEl.value = "";
      myExampleContentEl.value = "";
      myExampleStatus.textContent = "追加しました。";
      loadMyExamples();
    } catch (err) {
      myExampleStatus.textContent = `エラー: ${err.message}`;
    }
  });

  // --- 表示名変更 ---
  const displayNameInput = document.getElementById("display-name-input");
  const displayNameSaveBtn = document.getElementById("display-name-save-btn");
  const displayNameStatus = document.getElementById("display-name-status");

  displayNameSaveBtn.addEventListener("click", async () => {
    const displayName = displayNameInput.value.trim();
    if (!displayName) {
      displayNameStatus.textContent = "表示名を入力してください。";
      return;
    }
    displayNameStatus.textContent = "変更しています...";
    try {
      const res = await fetch("/api/change-display-name", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "変更に失敗しました。");
      renderUser(data.user);
      displayNameStatus.textContent = "変更しました。";
    } catch (err) {
      displayNameStatus.textContent = `エラー: ${err.message}`;
    }
  });

  // --- アカウント発行（管理者のみ） ---
  const adminAccountsListEl = document.getElementById("admin-accounts-list");

  async function loadAdminAccounts() {
    adminAccountsListEl.innerHTML = '<p class="muted">読み込み中...</p>';
    try {
      const res = await fetch("/api/admin/accounts");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "読み込みに失敗しました。");
      if (!data.length) {
        adminAccountsListEl.innerHTML = '<p class="muted">アカウントがありません。</p>';
        return;
      }
      adminAccountsListEl.innerHTML = data
        .map(
          (a) => `
        <div class="admin-account-item">
          <div class="top-row">
            <span class="name">${escapeHtml(a.displayName)}</span>
            ${a.isAdmin ? '<span class="type-badge">管理者</span>' : ""}
            <span class="time">${a.lastLoginAt ? `最終ログイン: ${formatDate(a.lastLoginAt)}` : "未ログイン"}</span>
          </div>
          <p class="preview-text">${escapeHtml(a.accountId)}（作成日: ${formatDate(a.createdAt)}）</p>
        </div>`
        )
        .join("");
    } catch (err) {
      adminAccountsListEl.innerHTML = `<p class="muted">エラー: ${escapeHtml(err.message)}</p>`;
    }
  }

  const adminNewUsernameEl = document.getElementById("admin-new-username");
  const adminNewDisplayNameEl = document.getElementById("admin-new-display-name");
  const adminNewPasswordEl = document.getElementById("admin-new-password");
  const adminCreateAccountBtn = document.getElementById("admin-create-account-btn");
  const adminCreateAccountStatus = document.getElementById("admin-create-account-status");

  adminCreateAccountBtn.addEventListener("click", async () => {
    const username = adminNewUsernameEl.value.trim();
    const displayName = adminNewDisplayNameEl.value.trim();
    const password = adminNewPasswordEl.value;
    if (!username || !displayName || !password) {
      adminCreateAccountStatus.textContent = "ユーザー名・表示名・パスワードをすべて入力してください。";
      return;
    }
    adminCreateAccountStatus.textContent = "発行しています...";
    try {
      const res = await fetch("/api/admin/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, displayName, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "発行に失敗しました。");
      adminCreateAccountStatus.textContent = `発行しました: ${data.account.accountId} (${data.account.displayName})`;
      adminNewUsernameEl.value = "";
      adminNewDisplayNameEl.value = "";
      adminNewPasswordEl.value = "";
      loadAdminAccounts();
    } catch (err) {
      adminCreateAccountStatus.textContent = `エラー: ${err.message}`;
    }
  });

  // --- パスワード変更 ---
  const currentPasswordEl = document.getElementById("current-password");
  const newPasswordEl = document.getElementById("new-password");
  const changePasswordBtn = document.getElementById("change-password-btn");
  const changePasswordStatus = document.getElementById("change-password-status");

  changePasswordBtn.addEventListener("click", async () => {
    changePasswordStatus.textContent = "変更しています...";
    try {
      const res = await fetch("/api/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: currentPasswordEl.value,
          newPassword: newPasswordEl.value,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "変更に失敗しました。");
      currentPasswordEl.value = "";
      newPasswordEl.value = "";
      changePasswordStatus.textContent = "変更しました。";
    } catch (err) {
      changePasswordStatus.textContent = `エラー: ${err.message}`;
    }
  });

  // --- 文章の癖・スタイル指示タブ ---
  const styleNotesRawEl = document.getElementById("style-notes-raw");
  const styleNotesSaveBtn = document.getElementById("style-notes-save-btn");
  const styleNotesReloadBtn = document.getElementById("style-notes-reload-btn");
  const styleNotesStatus = document.getElementById("style-notes-status");

  async function loadStyleNotes() {
    styleNotesStatus.textContent = "読み込み中...";
    try {
      const res = await fetch("/api/style-notes");
      const data = await res.json();
      styleNotesRawEl.value = data.raw;
      styleNotesStatus.textContent = "";
    } catch (err) {
      styleNotesStatus.textContent = `読み込みエラー: ${err.message}`;
    }
  }

  styleNotesSaveBtn.addEventListener("click", async () => {
    styleNotesStatus.textContent = "保存しています...";
    try {
      const res = await fetch("/api/style-notes", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw: styleNotesRawEl.value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "保存に失敗しました。");
      styleNotesStatus.textContent = "保存しました。";
    } catch (err) {
      styleNotesStatus.textContent = `エラー: ${err.message}`;
    }
  });

  styleNotesReloadBtn.addEventListener("click", loadStyleNotes);

  // --- ユーティリティ ---
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatDate(iso) {
    const d = new Date(iso);
    return d.toLocaleString("ja-JP");
  }

  playFadeInSequence([
    ...document.querySelectorAll("#tab-generate .generate-input .card"),
    resultCardEl,
    copyBtn,
  ]);
})();
