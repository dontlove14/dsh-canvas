(function () {
  "use strict";
  var modelDemo = document.querySelector("[data-demo-agent-model]");
  if (modelDemo) {
    var select = modelDemo.querySelector("[data-agent-model]");
    var send = modelDemo.querySelector("[data-model-send]");
    var empty = modelDemo.querySelector("[data-no-agent-model]");
    var result = modelDemo.querySelector("[data-agent-model-result]");
    var allowed = ["multimodal", "image"];
    var previous = select.value;
    function refreshModel() {
      select.disabled = empty.checked;
      send.disabled = empty.checked || !allowed.includes(select.value);
    }
    select.addEventListener("change", function () {
      if (!allowed.includes(select.value)) {
        select.value = previous;
        result.textContent = "拒绝不合格的选择，保留此前合格模型；没有合格选择时不能发送。";
      } else {
        previous = select.value;
        result.textContent = select.value === "image" ? "图片理解能力已确认；音视频输入仍需单独确认，不能据此声称全部支持。" : "合格多模态模型已选。普通文字任务也遵守预设模型资格限制。";
      }
      refreshModel();
    });
    empty.addEventListener("change", function () {
      select.value = ""; previous = "";
      result.textContent = empty.checked ? "没有合格模型，不能发送或续作；请配置多模态模型，已有内容保留。" : "请重新选择合格模型；不自动回退到纯文本模型。";
      refreshModel();
    });
    modelDemo.querySelector("[data-model-legacy]").addEventListener("click", function () {
      select.value = ""; previous = "";
      result.textContent = "旧纯文本选择不能沿用；保留会话和项目，请重新选择多模态模型。";
      refreshModel();
    });
    send.addEventListener("click", function () {
      if (!allowed.includes(select.value) || empty.checked) return;
      result.textContent = "示例资格校验通过；没有发送真实请求。";
    });
    refreshModel();
  }

  var demo = document.querySelector("[data-demo-creation]");
  if (demo) {
    var q = function (selector) { return demo.querySelector(selector); };
    var state;
    var states = {
      human: "C-01 人工编辑", agent: "C-02 Agent 创作中 · 用户只读",
      waiting: "C-03 Agent 待命 · 用户只读", uncertain: "C-06 状态待核对"
    };
    function note(text) { state.log.push(text); }
    function render() {
      q("[data-control]").textContent = states[state.owner];
      q("[data-project]").textContent = state.project ? "示例会话已关联同一画布；再次续作复用该目标。" : "尚未关联创作画布";
      q("[data-reply]").textContent = state.owner === "uncertain" ? "本页回复显示已冻结；宿主停止结果待核对。" : state.owner === "agent" ? "本轮示例回复进行中。" : "本轮没有进行中的示例回复。";
      q("[data-service-result]").textContent = "已确认操作：" + state.operations + "；原后台结果记录：" + state.results + "。";
      q("[data-summary]").textContent = state.changes > state.synced ? "存在已保存人工修改。系统自动整理真实变化，续作时提供，用户不必填写摘要。" : "尚无未同步的已保存人工修改。";
      q("[data-batch-count]").textContent = String(state.batches);
      q("[data-unsaved]").textContent = state.failedSave ? "人工修改保存失败，未成为已确认事实；续作先处理保存。" : "仅保存成功的操作进入人工上下文。";
      q("[data-agent-step]").disabled = state.owner !== "agent" || q("[data-offline]").checked;
      q("[data-finish]").disabled = state.owner !== "agent";
      q("[data-human-save]").disabled = state.owner !== "human";
      q("[data-takeover]").disabled = state.owner === "human";
      q("[data-start]").disabled = state.owner === "agent" || state.owner === "uncertain";
      q("[data-query]").disabled = !state.project || state.owner === "uncertain";
      q("[data-late-write]").disabled = state.retired === null;
      q("[data-task-result]").disabled = !state.project;
      var list = q("[data-log]");
      list.replaceChildren();
      state.log.slice(-7).forEach(function (text) {
        var li = document.createElement("li"); li.textContent = text; list.appendChild(li);
      });
    }
    function reset() {
      state = { owner: "human", project: false, epoch: 0, retired: null, pending: false, operations: 0, results: 0, changes: 0, synced: 0, batches: 0, failedSave: false, log: [] };
      q("[data-offline]").checked = false; q("[data-save-fail]").checked = false;
      note("文档示意：只解释共享服务、控制权和上下文交接，不执行具体创作功能。");
      render();
    }
    function takeover() {
      if (state.owner === "human") return;
      if (q("[data-offline]").checked) {
        state.owner = "uncertain"; state.pending = true;
        note("接管意图尚未被宿主确认，本页冻结；不能开放可能冲突的人工写入。");
      } else {
        state.retired = state.epoch; state.epoch += 1; state.owner = "human"; state.pending = false;
        note("接管生效：撤销旧写入资格，结束本轮回复，保留已确认内容。");
      }
      render();
    }
    function confirm(token) {
      if (state.owner !== "agent" || token !== state.epoch) {
        note("共享服务拒绝旧 Agent 的晚到写入；已确认内容没有改变。");
      } else {
        state.operations += 1;
        note("原生工具通过共享服务确认一项操作，返回回执；页面展示同一事实。");
      }
      render();
    }
    demo.addEventListener("click", function (event) {
      var button = event.target.closest("button");
      if (!button || button.disabled) return;
      if (button.hasAttribute("data-reset-creation")) { reset(); return; }
      if (button.hasAttribute("data-start")) {
        if (q("[data-offline]").checked) {
          note("连接不可用，保留用户意图，不开始创作。");
        } else if (q("[data-save-fail]").checked) {
          note("保存或同步失败，保持当前控制状态，不开始创作。");
        } else if (state.failedSave) {
          note("存在未保存的人工修改，请先重试保存；旧状态不能用于续作。");
        } else {
          if (!state.project) { state.project = true; note("自动准备目标并打开侧栏，关联示例会话与画布。"); }
          if (state.changes > state.synced) {
            state.synced = state.changes; state.batches += 1;
            note("自动同步尚未交付的人工修改，读取最新项目状态；已交付批次不重复。");
          }
          state.epoch += 1; state.owner = "agent";
          note("交接完成，开始本轮回复；创作写入由 Agent 持有，页面只读。");
        }
      }
      if (button.hasAttribute("data-agent-step")) { confirm(state.epoch); return; }
      if (button.hasAttribute("data-late-write")) { confirm(state.retired); return; }
      if (button.hasAttribute("data-takeover")) { takeover(); return; }
      if (button.hasAttribute("data-human-save")) {
        if (q("[data-save-fail]").checked || q("[data-offline]").checked) {
          state.failedSave = true;
          note("人工修改保存失败，不进入已确认上下文；草稿应保留。");
        } else {
          state.changes += 1; state.failedSave = false;
          note("人工修改保存成功，自动记录操作事实；Agent 保持停止，不自动回复。");
        }
      }
      if (button.hasAttribute("data-query")) note("仅查询真实状态；本次问答不取得画布写入权。");
      if (button.hasAttribute("data-task-result")) {
        state.results += 1;
        note("原后台任务仅更新自己的结果；不恢复旧 Agent，不执行后续创作。");
      }
      if (button.hasAttribute("data-finish")) {
        state.retired = state.epoch; state.epoch += 1; state.owner = "waiting";
        note("本轮结束，进入只读待命的建议状态；完成后是否仍只读待 D-06 评审。");
      }
      render();
    });
    q("[data-offline]").addEventListener("change", function () {
      if (!this.checked && state.pending) takeover(); else render();
    });
    q("[data-save-fail]").addEventListener("change", render);
    reset();
  }

  var guidance = document.querySelector("[data-demo-guidance]");
  if (guidance) {
    var examples = {
      beginner: ["我想创作一份内容，但我不懂怎么操作画布。", "你可以先说希望做出什么样的内容，我来帮你整理想法。你最希望别人看到或听到什么？", "先理解目标，逐步引导；不要求用户先学习工具或节点术语。"],
      professional: ["按我给定的专业参数继续，保留已经确认的素材。", "我会保留你确认的素材与参数，先核对当前已接入能力，再按你的要求继续。", "尊重专业精度，不承诺未实现能力，不重复用户已理解的基础解释。"],
      error: ["现在为什么不能继续？", "当前服务还不可用，已经保存的内容都还在。先处理服务配置后，我们可以从当前内容继续。", "说明实际原因、保留的成果和下一步；不只输出技术错误码。"]
    };
    guidance.addEventListener("click", function (event) {
      var button = event.target.closest("[data-audience]"); if (!button) return;
      var example = examples[button.dataset.audience];
      guidance.querySelector("[data-guidance-user]").textContent = example[0];
      guidance.querySelector("[data-guidance-agent]").textContent = example[1];
      guidance.querySelector("[data-guidance-note]").textContent = example[2];
      guidance.querySelectorAll("[data-audience]").forEach(function (item) { item.setAttribute("aria-pressed", String(item === button)); });
    });
  }

  var questionDemo = document.querySelector("[data-demo-question]");
  if (questionDemo) {
    var find = function (selector) { return questionDemo.querySelector(selector); };
    var question = { state: "none", token: 0, draft: "", count: 0, result: "", ended: false };
    function questionRefresh(message) {
      var waiting = question.state === "waiting";
      questionDemo.querySelectorAll("[data-question-option]").forEach(function (option) { option.disabled = !waiting; });
      find("[data-question-custom]").disabled = !waiting;
      ["[data-question-submit]", "[data-question-skip]", "[data-question-takeover]"].forEach(function (selector) { find(selector).disabled = !waiting; });
      find("[data-question-ask]").disabled = waiting;
      find("[data-question-duplicate]").disabled = question.state !== "answered";
      find("[data-question-late]").disabled = !question.ended;
      find("[data-question-count]").textContent = String(question.count);
      find("[data-question-result]").textContent = question.result || "尚无确认答案；推荐、草稿、跳过和取消不形成授权。";
      if (message) find("[data-question-state]").textContent = message;
    }
    function clearDraft() {
      question.draft = "";
      questionDemo.querySelectorAll("[data-question-option]").forEach(function (option) { option.checked = false; });
      find("[data-question-custom]").value = "";
    }
    questionDemo.querySelectorAll("[data-question-option]").forEach(function (option) {
      option.addEventListener("change", function () {
        if (question.state !== "waiting") return;
        question.draft = option.value;
        find("[data-question-custom]").value = "";
        questionRefresh("选项只是草稿，尚未提交；Agent 继续等待，不开始依赖此答案的操作。");
      });
    });
    find("[data-question-custom]").addEventListener("input", function () {
      if (question.state !== "waiting") return;
      question.draft = "";
      questionDemo.querySelectorAll("[data-question-option]").forEach(function (option) { option.checked = false; });
      questionRefresh("文本只是草稿，提交前不是答案；单选自定义文本与选项互斥。");
    });
    questionDemo.addEventListener("click", function (event) {
      var button = event.target.closest("button"); if (!button || button.disabled) return;
      if (button.hasAttribute("data-question-ask")) {
        question.token += 1; question.result = ""; question.ended = false; clearDraft();
        if (find("[data-question-unavailable]").checked) {
          question.state = "unavailable";
          questionRefresh("应答界面不可用，提问失败；不声称已收到答案，也不执行依赖动作。");
        } else {
          question.state = "waiting";
          questionRefresh("原生工具已发起示例问题，等待明确回答；画布控制权不因提问改变。");
        }
      } else if (button.hasAttribute("data-question-submit")) {
        if (question.state !== "waiting") return;
        var custom = find("[data-question-custom]").value.trim();
        if (!custom && !question.draft) {
          questionRefresh("尚未填写答案。请选择、输入，或明确跳过；不能自动使用推荐项。");
          return;
        }
        if (find("[data-question-stale]").checked) {
          question.state = "stale";
          question.result = "收到答案，但原候选已经失效；该决定未应用。";
          questionRefresh("最新业务校验拒绝应用旧选择；保留内容，按需重新获取候选并提问。");
          return;
        }
        question.state = "answered"; question.count += 1;
        question.result = JSON.stringify({ answers: [{ id: "creative_direction", selected: question.draft ? [question.draft] : [], ...(custom ? { custom: custom } : {}) }] });
        questionRefresh("答案按问题 ID 读取，最新状态校验通过；一份回答只确认一次，不自动变成生成请求。");
      } else if (button.hasAttribute("data-question-skip")) {
        question.state = "skipped";
        question.result = '{"answers":[{"id":"creative_direction","selected":[]}]}';
        questionRefresh("用户跳过，没有明确决定；必要的依赖动作不执行，已有内容保留。");
      } else if (button.hasAttribute("data-question-takeover")) {
        question.state = "cancelled"; question.token += 1; question.ended = true;
        question.result = "本轮提问已随接管取消；未提交草稿不形成授权。";
        questionRefresh("人工接管立即结束旧等待与本轮回复；不等用户先答题，不恢复旧创作。");
      } else if (button.hasAttribute("data-question-duplicate")) {
        questionRefresh("重复回执已忽略；同一答案不再次确认，也不造成重复业务执行。");
      } else if (button.hasAttribute("data-question-late")) {
        questionRefresh("旧提问已失效，迟到提交不能恢复旧 Agent 或重新取得画布控制权。");
      } else if (button.hasAttribute("data-question-reset")) {
        question = { state: "none", token: 0, draft: "", count: 0, result: "", ended: false };
        find("[data-question-unavailable]").checked = false; find("[data-question-stale]").checked = false;
        clearDraft(); questionRefresh("尚未发起提问。");
      }
    });
    questionRefresh();
  }

  if (window.mermaid) {
    var style = getComputedStyle(document.documentElement);
    window.mermaid.initialize({
      startOnLoad: false, theme: "base", securityLevel: "strict",
      themeVariables: {
        primaryColor: style.getPropertyValue("--bg2").trim(), primaryTextColor: style.getPropertyValue("--ink").trim(),
        primaryBorderColor: style.getPropertyValue("--rule").trim(), lineColor: style.getPropertyValue("--muted").trim(),
        fontFamily: style.getPropertyValue("--font").trim(), fontSize: "14px"
      }
    });
    Array.from(document.querySelectorAll("[data-diagram]")).reduce(function (promise, figure, index) {
      return promise.then(function () {
        return window.mermaid.render("agent-architecture-" + index, figure.querySelector("[data-diagram-source]").textContent).then(function (rendered) {
          figure.querySelector("[data-diagram-render]").innerHTML = rendered.svg;
          figure.querySelector("[data-diagram-fallback]").hidden = true;
        }).catch(function () { figure.querySelector("[data-diagram-fallback]").hidden = false; });
      });
    }, Promise.resolve());
  }
})();
