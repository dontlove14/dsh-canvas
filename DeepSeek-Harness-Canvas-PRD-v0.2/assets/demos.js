(function () {
  "use strict";

  document.documentElement.dataset.enhanced = "true";
  var preset = document.querySelector("[data-demo-preset]");
  if (preset) {
    var messages = {
      ready: "配置就绪：手动入口可用；选择无限画布助手后，可以开始对话创作。安装不会替换原默认预设。",
      storage: "未配置对象存储：可以打开目录和设置；新建画布、导入及新生成被阻止。不会创建一批无法执行的空项目。",
      video: "缺少可用视频模型：已有图片、音频与编辑内容保留；不提交视频生成，也不显示虚假视频结果。",
      preset: "预设加载失败：手动画布与已有数据仍可使用；Agent 创作不可用，需要先处理加载问题。"
    };
    preset.addEventListener("click", function (event) {
      var button = event.target.closest("[data-scenario]");
      if (!button) return;
      preset.querySelectorAll("[data-scenario]").forEach(function (item) {
        item.setAttribute("aria-pressed", String(item === button));
      });
      preset.querySelector("[data-preset-result]").textContent = messages[button.dataset.scenario];
    });
  }

  var modelDemo = document.querySelector("[data-demo-agent-model]");
  if (modelDemo) {
    var modelSelect = modelDemo.querySelector("[data-agent-model]");
    var modelSend = modelDemo.querySelector("[data-model-send]");
    var noModels = modelDemo.querySelector("[data-no-agent-model]");
    var modelResult = modelDemo.querySelector("[data-agent-model-result]");
    var lastQualified = modelSelect.value;
    var allowedModels = ["multimodal", "image"];
    function updateModelState() {
      modelSelect.disabled = noModels.checked;
      modelSend.disabled = noModels.checked || !allowedModels.includes(modelSelect.value);
    }
    modelSelect.addEventListener("change", function () {
      if (!allowedModels.includes(modelSelect.value)) {
        modelSelect.value = lastQualified;
        updateModelState();
        modelResult.textContent = "拒绝非多模态或能力未确认的选择，保留此前合格模型；没有合格选择时不能发送。";
        return;
      }
      lastQualified = modelSelect.value;
      updateModelState();
      modelResult.textContent = modelSelect.value === "image" ? "该示例模型已确认图片理解能力；音频或视频理解仍需单独确认，不能据此宣称全部支持。" : "已选合格的示例多模态模型。非多模态模型和能力未确认项不可选。";
    });
    noModels.addEventListener("change", function () {
      modelSelect.value = "";
      lastQualified = "";
      updateModelState();
      modelResult.textContent = noModels.checked ? "没有可用多模态模型：发送与续作不可用，请配置合格模型；手动画布和已有成果保留。" : "请重新选择合格的多模态模型。不会自动回退到纯文本模型或替用户选择其他模型。";
    });
    modelDemo.querySelector("[data-model-legacy]").addEventListener("click", function () {
      modelSelect.value = "";
      lastQualified = "";
      updateModelState();
      modelResult.textContent = "旧会话的纯文本模型不合格，已取消其有效选择。会话、输入和画布保留，请重新选择多模态模型。";
    });
    modelSend.addEventListener("click", function () {
      if (modelSend.disabled || !allowedModels.includes(modelSelect.value)) return;
      modelResult.textContent = "资格校验通过，可以发送示例助手消息；本演示未发送真实请求。";
    });
    updateModelState();
  }

  var demo = document.querySelector("[data-demo-creation]");
  if (demo) {
    var q = function (selector) { return demo.querySelector(selector); };
    var state;
    var clone = function (value) { return JSON.parse(JSON.stringify(value)); };
    var labels = {
      human: "C-01 人工编辑",
      agent: "C-02 Agent 创作中 · 用户只读",
      waiting: "C-03 Agent 待命 · 用户只读",
      sync: "C-05 续作同步中",
      uncertain: "C-06 状态待核对 · 暂不可编辑"
    };
    function reset() {
      state = {
        control: "human", project: false, nodes: [], step: 0, epoch: 1,
        retiredEpoch: null, agentRunning: false, pendingTakeover: false,
        events: [], syncedEvents: 0, changes: {}, deliveredBatches: 0,
        logs: [], stableNodes: [], dirty: false
      };
      q("[data-offline]").checked = false;
      q("[data-save-fail]").checked = false;
      q("[data-request]").value = "为夏日饮品做一段宣传视频，包含封面、画面和旁白。";
      q("[data-human-name]").value = "暖色封面";
      q("[data-human-prompt]").value = "暖色室内，夏日饮品的产品特写。";
      log("说明", "文档演示：所有目录、节点、任务和结果均为内存示例，不调用真实服务。");
      render();
    }
    function log(role, text) {
      state.logs.push({ role: role, text: text });
    }
    function firstNode() {
      return state.nodes.find(function (node) { return node.id === "cover"; }) || state.nodes[0];
    }
    function summary() {
      var changes = Object.keys(state.changes).map(function (key) {
        var change = state.changes[key];
        return change.before === change.after ? null : change.label + "从“" + change.before + "”改为“" + change.after + "”。";
      }).filter(Boolean);
      return changes.length ? changes.join(" ") : "当前人工批次没有有效的已保存创作修改；续作仍读取最新画布与任务状态。";
    }
    function track(key, label, before, after) {
      if (!state.changes[key]) state.changes[key] = { label: label, before: before, after: after };
      else state.changes[key].after = after;
    }
    function render() {
      q("[data-control]").textContent = labels[state.control];
      q("[data-control]").dataset.owner = state.control;
      q("[data-project]").textContent = state.project ? "文件夹：夏日饮品 / 画布：宣传视频（演示）" : "尚未准备目录与画布";
      q("[data-reply]").textContent = state.control === "uncertain" ? "本页回复显示已冻结；宿主是否停止仍待核对。" : state.agentRunning ? "示例回复正在进行；接管会立即结束本轮。" : "当前没有进行中的示例回复。";
      q("[data-summary]").textContent = summary();
      q("[data-batch-count]").textContent = String(state.deliveredBatches);
      q("[data-unsaved]").textContent = state.dirty ? "输入草稿尚未保存，不能交给 Agent 续作。" : "已确认内容可用；摘要只采用保存成功的修改。";
      var board = q("[data-board]");
      board.replaceChildren();
      if (!state.nodes.length) {
        var empty = document.createElement("p");
        empty.className = "demo-empty";
        empty.textContent = "发送创作要求后，示例会自动准备目录与画布。";
        board.appendChild(empty);
      }
      state.nodes.forEach(function (node) {
        var card = document.createElement("div");
        card.className = "demo-node";
        card.dataset.nodeId = node.id;
        var title = document.createElement("strong");
        title.textContent = node.name;
        var type = document.createElement("span");
        type.className = "demo-node-type";
        type.textContent = node.type;
        var detail = document.createElement("p");
        detail.textContent = node.prompt;
        var status = document.createElement("small");
        status.textContent = node.status;
        card.append(type, title, detail, status);
        board.appendChild(card);
      });
      var logArea = q("[data-log]");
      logArea.replaceChildren();
      state.logs.slice(-8).forEach(function (entry) {
        var item = document.createElement("li");
        var role = document.createElement("strong");
        role.textContent = entry.role + "：";
        item.append(role, document.createTextNode(entry.text));
        logArea.appendChild(item);
      });
      q("[data-takeover]").disabled = !["agent", "waiting", "uncertain"].includes(state.control);
      q("[data-agent-step]").disabled = state.control !== "agent" || q("[data-offline]").checked;
      q("[data-chat-stop]").disabled = state.control !== "agent";
      q("[data-human-save]").disabled = state.control !== "human" || !state.project;
      q("[data-human-name]").disabled = state.control !== "human" || !state.project;
      q("[data-human-prompt]").disabled = state.control !== "human" || !state.project;
      q("[data-manual-create]").disabled = state.control !== "human" || state.project;
      q("[data-late-write]").disabled = state.retiredEpoch === null;
      q("[data-task-result]").disabled = !state.nodes.some(function (node) { return node.id === "voice"; });
      q("[data-start]").disabled = state.control === "agent" || state.control === "uncertain";
      q("[data-query]").disabled = !state.project || state.control === "uncertain";
    }
    function createProject(manual) {
      state.project = true;
      state.nodes = [{
        id: "cover", name: "封面", type: "图片生成",
        prompt: "夏日饮品的产品特写。", status: "输入草稿 · 无实际媒体文件"
      }];
      state.stableNodes = clone(state.nodes);
      log(manual ? "人工操作" : "系统", manual ? "创建了演示画布；当前由用户编辑。" : "自动打开侧栏，创建夏日饮品文件夹与宣传视频画布。");
    }
    function start() {
      var request = q("[data-request]").value.trim();
      if (!request) {
        log("提示", "请填写本轮创作要求；空内容不会创建项目或交出控制权。");
        render(); return;
      }
      if (q("[data-offline]").checked) {
        log("提示", "连接不可用，保留要求，不开始示例创作。");
        render(); return;
      }
      if (state.control === "human" && q("[data-save-fail]").checked) {
        state.dirty = true;
        log("提示", "保存 / 交接同步失败，保持人工控制；新要求保留，旧 Agent 不开始。");
        render(); return;
      }
      log("用户要求", request);
      if (!state.project) createProject(false);
      if (state.control === "human") {
        if (state.dirty) {
          saveHuman();
          if (state.dirty) return;
        }
        state.control = "sync";
        if (state.events.length > state.syncedEvents) {
          log("人工修改上下文", summary());
          state.syncedEvents = state.events.length;
          state.deliveredBatches += 1;
        }
        log("系统", "已读取最新画布与任务状态，交接成功；未同步修改只作为上下文交付一次。");
        state.changes = {};
      }
      state.epoch += 1;
      state.control = "agent";
      state.agentRunning = true;
      log("Agent", "开始本轮示例创作，画布进入只读观察。可点击下一步查看过程，或随时人工接管。");
      render();
    }
    function agentStep(token) {
      if (token !== state.epoch || state.control !== "agent") {
        log("系统", "拒绝旧 Agent 的晚到写入；当前节点、人工输入与引用均未改变。");
        render(); return;
      }
      state.step += 1;
      if (state.step === 1) {
        firstNode().status = "示例图片任务已接受 · 等待结果";
        state.nodes.push({
          id: "voice", name: "旁白", type: "语音生成",
          prompt: "一杯清凉，开启夏日。", status: "示例语音任务已接受 · 等待结果"
        });
        log("Agent", "提交示例图片与配音任务；实际产品中要保存原任务身份，不能伪造媒体文件。");
      } else if (state.step === 2) {
        firstNode().status = "示例图片任务结果记录就绪 · 无真实图片";
        state.nodes.push({
          id: "video", name: "产品画面", type: "视频生成",
          prompt: "以封面结果为参考，拍摄产品特写。", status: "示例引用：封面 → 产品画面"
        });
        log("Agent", "示例上游结果确认后，创建并关联下游视频节点。");
      } else if (state.step === 3) {
        state.nodes.push({
          id: "edit", name: "宣传成片", type: "视频编辑",
          prompt: "组织产品画面与旁白，形成成片。", status: "示例编辑草稿 · 不提供真实视频"
        });
        log("Agent", "创建可查看的编辑草稿；原素材保持，编辑输出是独立结果。");
      } else {
        state.control = "waiting";
        state.agentRunning = false;
        log("Agent", "本轮演示结束。真实产品只有文件可用才能交付；当前保持只读待命，可以接管或继续对话。");
      }
      state.stableNodes = clone(state.nodes);
      render();
    }
    function takeover() {
      if (state.control === "human") return;
      if (q("[data-offline]").checked) {
        state.pendingTakeover = true;
        state.control = "uncertain";
        log("提示", "本页冻结观察，但宿主尚未确认停止；保持不可编辑，重连后核对接管结果。");
        render(); return;
      }
      state.retiredEpoch = state.epoch;
      state.epoch += 1;
      state.control = "human";
      state.agentRunning = false;
      state.pendingTakeover = false;
      state.changes = {};
      state.stableNodes = clone(state.nodes);
      var node = firstNode();
      if (node) {
        q("[data-human-name]").value = node.name;
        q("[data-human-prompt]").value = node.prompt;
      }
      log("系统", "人工接管生效：旧 Agent 写入已撤销，本轮回复结束。已确认内容保留，不等待外部生成终止。");
      render();
    }
    function saveHuman() {
      if (state.control !== "human") return;
      var name = q("[data-human-name]").value.trim();
      var prompt = q("[data-human-prompt]").value.trim();
      if (!name || !prompt) {
        log("提示", "名称与提示词不能为空，输入保留。");
        render(); return;
      }
      if (q("[data-save-fail]").checked || q("[data-offline]").checked) {
        state.dirty = true;
        log("提示", "保存失败：输入草稿保留，尚未写入已保存摘要，也不能交回 Agent。");
        render(); return;
      }
      var node = firstNode();
      var beforeName = node.name;
      var beforePrompt = node.prompt;
      node.name = name;
      node.prompt = prompt;
      if (beforeName !== name || beforePrompt !== prompt) {
        track(node.id + ":name", "封面节点名称", beforeName, name);
        track(node.id + ":prompt", "封面节点提示词", beforePrompt, prompt);
        state.events.push({ id: state.events.length + 1, node: node.id });
        log("人工操作", "修改保存成功；自动记录语义变化，不自动发送对话或唤醒 Agent。");
      } else {
        log("人工操作", "没有新的有效变化，不生成重复操作记录。");
      }
      state.stableNodes = clone(state.nodes);
      state.dirty = false;
      render();
    }
    demo.addEventListener("click", function (event) {
      var button = event.target.closest("button");
      if (!button || button.disabled) return;
      if (button.hasAttribute("data-reset-creation")) reset();
      if (button.hasAttribute("data-start")) start();
      if (button.hasAttribute("data-manual-create")) { createProject(true); render(); }
      if (button.hasAttribute("data-agent-step")) agentStep(state.epoch);
      if (button.hasAttribute("data-takeover")) takeover();
      if (button.hasAttribute("data-late-write")) agentStep(state.retiredEpoch);
      if (button.hasAttribute("data-human-save")) saveHuman();
      if (button.hasAttribute("data-query")) {
        log("问答", "查询原任务与已保存修改，不进行创作性写入，也不改变当前控制权。");
        render();
      }
      if (button.hasAttribute("data-task-result")) {
        var voice = state.nodes.find(function (node) { return node.id === "voice"; });
        if (voice) {
          voice.status = "原示例任务结果记录到达 · 不自动执行下游";
          log("媒体任务", "原语音任务只更新自身结果记录；不改人工提示词，不创建连线，不恢复 Agent 回复。");
          render();
        }
      }
      if (button.hasAttribute("data-chat-stop")) {
        state.retiredEpoch = state.epoch;
        state.epoch += 1;
        state.agentRunning = false;
        state.control = "waiting";
        log("系统", "在对话中停止了本轮；画布保持只读待命，人工编辑仍需点击接管。");
        render();
      }
    });
    q("[data-offline]").addEventListener("change", function () {
      if (!this.checked && state.pendingTakeover) takeover();
      else render();
    });
    q("[data-save-fail]").addEventListener("change", render);
    [q("[data-human-name]"), q("[data-human-prompt]")].forEach(function (input) {
      input.addEventListener("input", function () {
        if (state.control !== "human") return;
        state.dirty = true;
        q("[data-unsaved]").textContent = "输入草稿尚未保存；续作将先保存，失败时保持人工控制。";
      });
    });
    reset();
  }

  var editor = document.querySelector("[data-demo-editing]");
  if (editor) {
    var clips = [
      { name: "片段一", start: 0, end: 4 },
      { name: "片段二", start: 4, end: 8 }
    ];
    var outputs = [];
    function editingMessage(text, error) {
      var node = editor.querySelector("[data-edit-result]");
      node.textContent = text;
      node.dataset.error = String(Boolean(error));
    }
    function readClips() {
      editor.querySelectorAll("[data-clip]").forEach(function (row, index) {
        clips[index].start = Number(row.querySelector("[data-clip-start]").value);
        clips[index].end = Number(row.querySelector("[data-clip-end]").value);
      });
    }
    function renderClips() {
      var list = editor.querySelector("[data-clips]");
      list.replaceChildren();
      clips.forEach(function (clip) {
        var row = document.createElement("div");
        row.className = "clip-row";
        row.dataset.clip = "";
        var name = document.createElement("strong");
        name.textContent = clip.name;
        var startLabel = document.createElement("label");
        startLabel.textContent = "开始（秒）";
        var start = document.createElement("input");
        start.type = "number"; start.min = "0"; start.max = "12"; start.step = "0.1";
        start.value = String(clip.start); start.dataset.clipStart = "";
        startLabel.appendChild(start);
        var endLabel = document.createElement("label");
        endLabel.textContent = "结束（秒）";
        var end = document.createElement("input");
        end.type = "number"; end.min = "0"; end.max = "12"; end.step = "0.1";
        end.value = String(clip.end); end.dataset.clipEnd = "";
        endLabel.appendChild(end);
        row.append(name, startLabel, endLabel);
        list.appendChild(row);
      });
    }
    editor.addEventListener("click", function (event) {
      var button = event.target.closest("button");
      if (!button) return;
      if (button.hasAttribute("data-reorder")) {
        readClips(); clips.reverse(); renderClips();
        editingMessage("片段顺序已调整；原媒体不变，先前结果不被覆盖。", false);
      }
      if (button.hasAttribute("data-invalid-edit")) {
        readClips(); clips[0].end = clips[0].start;
        renderClips(); editingMessage("已设置无效区间。点击校验可看到制作被阻止。", false);
      }
      if (button.hasAttribute("data-export-edit")) {
        readClips();
        var invalid = clips.find(function (clip) {
          return !Number.isFinite(clip.start) || !Number.isFinite(clip.end) || clip.start < 0 || clip.end > 12 || clip.end <= clip.start;
        });
        if (invalid) {
          editingMessage(invalid.name + "区间无效：须在示例视频的 0–12 秒内，结束大于开始。草稿保留，没有制作新结果。", true);
          return;
        }
        var duration = clips.reduce(function (sum, clip) { return sum + clip.end - clip.start; }, 0);
        var offset = Number(editor.querySelector("[data-audio-offset]").value);
        if (!Number.isFinite(offset) || offset < 0 || offset >= duration) {
          editingMessage("音轨开始位置须位于有效画面范围内。制作被阻止，草稿保留。", true);
          return;
        }
        var entry = "示例结果 " + (outputs.length + 1) + "：" + clips.map(function (clip) {
          return clip.name + " " + clip.start + "–" + clip.end + " 秒";
        }).join(" → ") + "；画面总时长 " + Number(duration.toFixed(2)) + " 秒；音轨从 " + offset + " 秒开始。";
        outputs.push(entry);
        editingMessage("校验通过，新增了一份独立的示例结果记录；未生成真实视频或下载文件。", false);
        var list = editor.querySelector("[data-edit-outputs]");
        list.replaceChildren();
        outputs.forEach(function (text) {
          var li = document.createElement("li"); li.textContent = text; list.appendChild(li);
        });
      }
      if (button.hasAttribute("data-reset-edit")) {
        clips = [{ name: "片段一", start: 0, end: 4 }, { name: "片段二", start: 4, end: 8 }];
        outputs = []; editor.querySelector("[data-audio-offset]").value = "0";
        editor.querySelector("[data-edit-outputs]").replaceChildren();
        renderClips(); editingMessage("示例已重置；请选择区间、顺序与音轨位置。", false);
      }
    });
    renderClips();
  }

  var guidance = document.querySelector("[data-demo-guidance]");
  if (guidance) {
    var examples = {
      beginner: {
        user: "我想给新开的咖啡店做个宣传视频，但我不会剪辑。",
        agent: "可以。我来帮你做画面、配上介绍声音，再合成视频。你最想展示店里的什么？",
        note: "先问一个影响内容的问题，不要求用户理解节点、连线或模型参数。"
      },
      professional: {
        user: "做一条竖版 9:16 的产品视频，保留我选好的片段和旁白。",
        agent: "按 9:16 组织成片，保留你已选的片段与旁白。我会先检查素材和模型支持范围，再继续后续画面。",
        note: "准确保留专业术语、参数和创作决策；仍核对真实能力，不直接承诺不支持的输出。"
      },
      error: {
        user: "为什么这次图片没出来？",
        agent: "这次图片没有生成成功，已经完成的内容都还在。图片服务返回了密钥无效的提示，请到模型设置更新后再试。",
        note: "示例前提是明确的鉴权错误。说明问题、保留的成果与下一步，不只输出错误码，不猜测原因。"
      }
    };
    guidance.addEventListener("click", function (event) {
      var button = event.target.closest("[data-audience]");
      if (!button) return;
      var example = examples[button.dataset.audience];
      guidance.querySelector("[data-guidance-user]").textContent = example.user;
      guidance.querySelector("[data-guidance-agent]").textContent = example.agent;
      guidance.querySelector("[data-guidance-note]").textContent = example.note;
      guidance.querySelectorAll("[data-audience]").forEach(function (item) {
        item.setAttribute("aria-pressed", String(item === button));
      });
    });
  }

  if (window.mermaid) {
    var figure = document.querySelector("[data-control-diagram]");
    if (figure) {
      var style = getComputedStyle(document.documentElement);
      window.mermaid.initialize({
        startOnLoad: false, theme: "base", securityLevel: "loose",
        themeVariables: {
          primaryColor: style.getPropertyValue("--bg2").trim(),
          primaryTextColor: style.getPropertyValue("--ink").trim(),
          primaryBorderColor: style.getPropertyValue("--rule").trim(),
          lineColor: style.getPropertyValue("--muted").trim(),
          fontFamily: style.getPropertyValue("--font").trim(),
          fontSize: "14px"
        }
      });
      window.mermaid.render("control-flow-svg", figure.querySelector("[data-diagram-source]").textContent).then(function (result) {
        figure.querySelector("[data-diagram-render]").innerHTML = result.svg;
        figure.querySelector("[data-diagram-fallback]").hidden = true;
      }).catch(function () {
        figure.querySelector("[data-diagram-fallback]").hidden = false;
      });
    }
  }

  if (window.IntersectionObserver) {
    var headings = document.querySelectorAll("main section.chapter");
    var nav = document.querySelector(".toc");
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        nav.querySelectorAll("[aria-current]").forEach(function (link) { link.removeAttribute("aria-current"); });
        var link = nav.querySelector('a[href="#' + entry.target.id + '"]');
        if (link) link.setAttribute("aria-current", "location");
      });
    }, { rootMargin: "-15% 0px -70% 0px" });
    headings.forEach(function (heading) { observer.observe(heading); });
  }
})();
