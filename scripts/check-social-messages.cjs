// Synthetic browser fixture only. Every API is intercepted; no actual private message or AI call.
const { chromium } = require("playwright"),
  assert = require("node:assert/strict"),
  path = require("node:path");
const base = process.env.SOCIAL_TEST_BASE || "http://127.0.0.1:4184/";
const hash = process.env.SOCIAL_TEST_HASH === "1",
  origin = new URL(base).origin;
const target = (query) =>
  base.replace(/\/?$/, "/") + (hash ? "#/" : "") + "messages" + query;
const user = {
  id: 99015,
  username: "虚构私信验收",
  email: "social@example.test",
  role: "USER",
  level: 1,
  points: 0,
};
const peer = {
  id: 99016,
  username: "雨后散步",
  avatar: null,
  status: "ACTIVE",
};
const message = (id, senderId, content) => ({
  id: String(id),
  senderId,
  content,
  clientMessageId: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
  createdAt: "2026-10-15T02:30:00Z",
});
(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    for (const width of [390, 1440]) {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        isMobile: width < 900,
        hasTouch: width < 900,
      });
      const errors = [],
        calls = [],
        reads = [];
      let id = 80,
        loseConfirmation = false,
        holdPollConfirmation = false;
      const rows = Array.from({ length: 35 }, (_, i) =>
        message(
          i + 1,
          i % 2 ? user.id : peer.id,
          `虚构私信 ${i + 1}：这里讨论社区里的共同话题。`,
        ),
      );
      rows[34].content =
        "<img src=x onerror=alert(1)> **普通文字，不执行 HTML**";
      const thread = {
        id: 501,
        peer,
        state: "ACCEPTED",
        requestDirection: null,
        canSend: true,
        canAccept: false,
        canDecline: false,
        blocked: false,
        blockedByMe: false,
        unreadCount: 2,
        lastMessage: rows[34],
      };
      const stranger = {
        ...thread,
        id: 502,
        peer: { ...peer, id: 99017, username: "新来的同学" },
        state: "PENDING",
        requestDirection: "incoming",
        canSend: false,
        canAccept: true,
        canDecline: true,
        lastMessage: message(60, 99017, "你好，可以聊聊这篇帖子吗？"),
      };
      const outgoing = {
        ...thread,
        id: 503,
        peer: { ...peer, id: 99018, username: "远方的朋友" },
        state: "PENDING",
        requestDirection: "outgoing",
        canSend: true,
        lastMessage: null,
        unreadCount: 0,
      };
      const all = [thread, stranger, outgoing],
        byId = (value) => all.find((t) => t.id === Number(value));
      const bodies = (t) =>
        t.id === 501
          ? rows
          : t.id === 502
            ? [stranger.lastMessage]
            : t.lastMessage
              ? [t.lastMessage]
              : [];
      const summary = (t) => ({
        ...t,
        lastMessage: t.blocked ? null : t.lastMessage,
        unreadCount: t.blocked ? 0 : t.unreadCount,
      });
      await page.route("**/*", async (r) => {
        const req = r.request(),
          url = new URL(req.url()),
          p = url.pathname,
          method = req.method();
        if (p.startsWith("/api/")) {
          if (method === "OPTIONS")
            return r.fulfill({
              status: 204,
              headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Methods": "*",
              },
            });
          calls.push([method, p]);
          let data = [],
            status = 200;
          if (p === "/api/direct-messages/unread-count")
            data = { inbox: 2, requests: 1, total: 3 };
          else if (p === "/api/direct-messages/contacts")
            data = { data: [peer] };
          else if (
            p === "/api/direct-messages/conversations" &&
            method === "GET"
          )
            data = {
              data: (url.searchParams.get("box") === "requests"
                ? [stranger]
                : [thread, outgoing]
              ).map(summary),
              hasMore: false,
              nextCursor: null,
            };
          else if (
            p === "/api/direct-messages/conversations" &&
            method === "POST"
          )
            data = { conversation: summary(thread) };
          else if (p.match(/\/conversations\/\d+$/))
            data = { conversation: summary(byId(p.split("/").pop())) };
          else if (p.match(/\/conversations\/\d+\/messages$/)) {
            const t = byId(p.split("/").at(-2));
            if (method === "POST") {
              const b = req.postDataJSON(),
                m = {
                  ...message(++id, user.id, b.content),
                  clientMessageId: b.clientMessageId,
                };
              const prior = bodies(t).find(
                (old) => old.clientMessageId === b.clientMessageId,
              );
              if (!prior) {
                if (t.id === 501) rows.push(m);
                t.lastMessage = m;
                if (t.id === 503) t.canSend = false;
              }
              data = { message: prior || m, conversation: summary(t) };
              if (loseConfirmation) {
                loseConfirmation = false;
                holdPollConfirmation = true;
                status = 503;
                data = null;
              } else if (t.id === 503) holdPollConfirmation = false;
            } else if (t.blocked) {
              throw Error("UI must not request message bodies while blocked");
            } else {
              const after = url.searchParams.get("afterId"),
                cursor = url.searchParams.get("cursor");
              // Keep the committed intro out of polling until manual retry, so this
              // fixture tests uncertain-send recovery rather than a timer race.
              let items = t.id === 503 && holdPollConfirmation ? [] : bodies(t);
              items = after
                ? items.filter((m) => BigInt(m.id) > BigInt(after))
                : cursor
                  ? items.slice(0, 5)
                  : items.slice(-30);
              data = {
                conversation: summary(t),
                data: items,
                nextCursor: t.id === 501 && !after && !cursor ? "older" : null,
                lastReadMessageId: "0",
              };
            }
          } else if (p.endsWith("/read")) {
            const b = req.postDataJSON();
            reads.push(b.lastReadMessageId);
            data = { lastReadMessageId: b.lastReadMessageId, unreadCount: 0 };
          } else if (p.endsWith("/request")) {
            const t = byId(p.split("/").at(-2));
            t.state =
              req.postDataJSON().action === "accept" ? "ACCEPTED" : "DECLINED";
            t.canSend = t.state === "ACCEPTED";
            t.canAccept = !t.canSend;
            t.requestDirection = null;
            data = { conversation: summary(t) };
          } else if (p.endsWith("/block")) {
            thread.blocked = thread.blockedByMe = req.postDataJSON().blocked;
            thread.canSend = !thread.blocked;
            data = { blocked: thread.blocked };
          }
          return r.fulfill({
            status,
            contentType: "application/json",
            headers: { "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify(
              status === 200
                ? { success: true, data }
                : { success: false, message: "虚构网络确认失败" },
            ),
          });
        }
        return url.origin === origin ? r.continue() : r.abort();
      });
      await page.addInitScript(
        ({ user }) =>
          localStorage.setItem(
            "chatforum-user",
            JSON.stringify({
              user,
              token: "synthetic-social-token",
              refreshToken: "",
            }),
          ),
        { user },
      );
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(target("?thread=501"));
      await page.locator(".direct-message").last().waitFor();
      await page.waitForFunction(() => {
        const e = document.querySelector(".message-scroll");
        return e && e.scrollHeight - e.scrollTop - e.clientHeight < 5;
      });
      await page.waitForFunction(
        () => !document.querySelector(".conversation-empty"),
      );
      assert(
        (await page.locator(".message-bubble").last().innerText()).includes(
          "<img src=x",
        ),
      );
      assert.equal(
        await page.locator(".message-bubble img").count(),
        0,
        "private texts are never HTML/Markdown",
      );
      await page.waitForTimeout(150);
      assert(
        reads.includes("35"),
        "initial read acknowledges only latest displayed ID",
      );
      assert(
        await page
          .getByRole("button", { name: "发送私信", exact: true })
          .isVisible(),
      );
      assert(
        await page
          .locator(".direct-composer")
          .evaluate((el) => el.getBoundingClientRect().bottom <= innerHeight),
        "composer stays on screen",
      );
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        "no horizontal overflow",
      );
      await page
        .getByRole("button", { name: "查看更早消息", exact: true })
        .click();
      await page.waitForFunction(
        () => document.querySelectorAll(".direct-message").length === 35,
      );
      await page
        .getByRole("textbox", { name: "私信内容", exact: true })
        .fill("普通私信\n保留换行");
      await page.getByRole("button", { name: "发送私信", exact: true }).click();
      await page
        .locator(".message-bubble")
        .getByText("普通私信\n保留换行", { exact: true })
        .waitFor();
      // Same-recipient contact selection must not leave the pane in an infinite opening state.
      if (width < 900)
        await page
          .getByRole("button", { name: "返回私信列表", exact: true })
          .click();
      await page.getByRole("button", { name: "新私信", exact: true }).click();
      await page
        .getByRole("textbox", { name: "搜索私信联系人", exact: true })
        .fill("雨后");
      await page.locator(".contact-results button").click();
      await page
        .getByRole("textbox", { name: "私信内容", exact: true })
        .waitFor();
      await page.waitForTimeout(350); // Element Plus dialog leave transition must finish before visual capture.
      if (width >= 900)
        await page.screenshot({
          path: path.join(".local", `social-messages-${width}.png`),
        });
      // Screenshots use fictional names and messages only.
      if (width < 900)
        await page.screenshot({
          path: path.join(".local", `social-messages-${width}.png`),
        });
      await page.getByRole("button", { name: "私信设置", exact: true }).click();
      await page.getByText("屏蔽此成员", { exact: true }).click();
      await page.getByRole("button", { name: "屏蔽", exact: true }).click();
      await page
        .getByText("你已屏蔽此成员，私信内容已隐藏。", { exact: false })
        .waitFor();
      assert.equal(await page.locator(".message-bubble").count(), 0);
      await page
        .locator(".blocked-note")
        .getByText("解除屏蔽", { exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "解除屏蔽", exact: true })
        .getByRole("button", { name: "解除屏蔽", exact: true })
        .click();
      await page.locator(".direct-message").last().waitFor();
      await page.goto(target("?thread=502&box=requests"));
      await page.getByRole("button", { name: "接受请求", exact: true }).click();
      await page.waitForFunction(
        () => !document.querySelector(".relationship-note"),
      );
      assert(
        await page
          .getByRole("textbox", { name: "私信内容", exact: true })
          .isEnabled(),
      );
      await page.goto(target("?thread=503"));
      await page
        .getByRole("textbox", { name: "私信内容", exact: true })
        .fill("你好，这是一条不会重复发送的介绍。");
      loseConfirmation = true;
      await page.getByRole("button", { name: "发送私信", exact: true }).click();
      await page.getByText("尚未确认发送结果", { exact: false }).waitFor();
      await page.getByRole("button", { name: "重试发送", exact: true }).click();
      await page.waitForFunction(() => !document.querySelector(".send-status"));
      assert.equal(
        await page
          .locator(".message-bubble")
          .getByText("你好，这是一条不会重复发送的介绍。", { exact: true })
          .count(),
        1,
        "server idempotency keeps one displayed message",
      );
      assert.equal(bodies(outgoing).length, 1);
      assert.deepEqual(errors, []);
      assert(
        !calls.some(([, p]) => p.includes("/chat/runs")),
        "private messaging never calls the AI",
      );
      console.log(
        `PASS ${width}px: DM entry, original text, read target, history, request acceptance, same-peer navigation, blocking, retry idempotency, responsive composer`,
      );
      await page.close();
    }
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
