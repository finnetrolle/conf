import assert from "node:assert/strict"
import { chromium, request } from "playwright"

const baseUrl = process.env.E2E_BASE_URL ?? "https://localhost:3000"
const headless = process.env.E2E_HEADLESS !== "false"
const scenarios = (process.env.E2E_SCENARIOS ?? "auto,relay")
  .split(",")
  .map((scenario) => scenario.trim())
  .filter(Boolean)

async function createSession() {
  const api = await request.newContext({
    baseURL: baseUrl,
    ignoreHTTPSErrors: true,
  })

  try {
    const response = await api.post("/api/sessions", {
      headers: { "Content-Type": "application/json" },
      timeout: 10_000,
    })
    assert.equal(response.status(), 201, "session creation should return 201")
    return await response.json()
  } finally {
    await api.dispose()
  }
}

function withIceTransport(url, mode) {
  const nextUrl = new URL(url)
  if (mode === "relay") {
    nextUrl.searchParams.set("support", "1")
    nextUrl.searchParams.set("iceTransport", "relay")
  }
  return nextUrl.toString()
}

function attachPageDebug(page, label) {
  page.on("console", (message) => {
    console.log(`${label}:console:${message.type()}:${message.text()}`)
  })
  page.on("pageerror", (error) => {
    console.log(`${label}:pageerror:${error.message}`)
  })
}

async function readConnectionPath(page, required = false) {
  const badge = page.getByTestId("connection-path")
  if (required) {
    await badge.waitFor({ state: "visible", timeout: 15_000 })
    return (await badge.textContent())?.trim() ?? "unknown"
  }

  return await page.evaluate(() => {
    const badgeEl = document.querySelector("[data-testid='connection-path']")
    return badgeEl?.textContent?.trim() ?? "unknown"
  })
}

async function waitForStage(page, expectedText, timeout = 20_000) {
  await page.getByTestId("connection-stage").waitFor({ state: "visible", timeout })
  await page.waitForFunction((text) => {
    const el = document.querySelector("[data-testid='connection-stage']")
    return el?.textContent?.includes(text)
  }, expectedText, { timeout })
}

async function assertSupportModeVisibility(page, mode) {
  const snapshot = await page.evaluate(() => ({
    supportBadge: document.body.textContent?.includes("Режим помощи") ?? false,
    callCode: document.body.textContent?.includes("код звонка") ?? false,
    connectionPath: Boolean(document.querySelector("[data-testid='connection-path']")),
  }))

  if (mode === "relay") {
    assert.equal(snapshot.supportBadge, true, "relay mode should expose support diagnostics")
    assert.equal(snapshot.callCode, true, "relay mode should show call code")
    return
  }

  assert.equal(snapshot.supportBadge, false, "default mode should hide support diagnostics")
  assert.equal(snapshot.callCode, false, "default mode should hide call code")
  assert.equal(snapshot.connectionPath, false, "default mode should hide connection path badge")
}

async function verifyInviteFlow(page, shareUrl, mode) {
  await waitForStage(page, "Ждем собеседника")

  await page.evaluate(() => {
    window.__shareCallCount = 0
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: () => true,
    })

    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async () => {
        window.__shareCallCount += 1
      },
    })
  })

  await page.getByRole("button", { name: "Отправить приглашение" }).click()
  await page.waitForFunction(() => window.__shareCallCount === 1, undefined, { timeout: 5_000 })
  await page.waitForFunction(() => !document.querySelector("[role='dialog']"), undefined, { timeout: 5_000 })

  await page.evaluate(() => {
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async () => {
        throw new DOMException("User aborted share", "AbortError")
      },
    })
  })

  await page.getByRole("button", { name: "Отправить приглашение" }).click()

  const dialog = page.getByRole("dialog", { name: "Отправить приглашение" })
  await dialog.waitFor({ state: "visible", timeout: 10_000 })
  await dialog.getByText("Отправка отменена. Можно выбрать другой способ приглашения ниже.").waitFor({
    state: "visible",
    timeout: 10_000,
  })

  const whatsAppHref = await dialog.getByRole("link", { name: /WhatsApp/ }).getAttribute("href")
  assert.ok(
    whatsAppHref?.includes(encodeURIComponent(shareUrl)),
    `WhatsApp invite link should include encoded share url (${mode})`,
  )

  const telegramHref = await dialog.getByRole("link", { name: /Telegram/ }).getAttribute("href")
  assert.ok(
    telegramHref?.includes(encodeURIComponent(shareUrl)),
    `Telegram invite link should include encoded share url (${mode})`,
  )

  const smsHref = await dialog.getByRole("link", { name: /SMS/ }).getAttribute("href")
  assert.match(smsHref ?? "", /^sms:/, `SMS invite link should use sms: protocol (${mode})`)
  assert.ok(
    smsHref?.includes(encodeURIComponent(shareUrl)),
    `SMS invite link should include encoded share url (${mode})`,
  )

  const emailHref = await dialog.getByRole("link", { name: /E-mail/ }).getAttribute("href")
  assert.match(emailHref ?? "", /^mailto:/, `Email invite link should use mailto: protocol (${mode})`)
  assert.ok(
    emailHref?.includes(encodeURIComponent(shareUrl)),
    `Email invite link should include encoded share url (${mode})`,
  )

  const qrImage = dialog.getByAltText("QR-код приглашения на видеозвонок")
  await qrImage.waitFor({ state: "visible", timeout: 10_000 })
  const qrSrc = await qrImage.getAttribute("src")
  assert.match(qrSrc ?? "", /^data:image\/png;base64,/, `QR code should be rendered as a data URL (${mode})`)

  await dialog.getByRole("button", { name: "Скопировать ссылку" }).click()
  await page.waitForFunction(async (expectedValue) => {
    return (await navigator.clipboard.readText()) === expectedValue
  }, shareUrl, { timeout: 5_000 })
  await dialog.getByText("Ссылка для подключения скопирована.").waitFor({ state: "visible", timeout: 5_000 })

  await dialog.getByRole("button", { name: "Закрыть панель приглашения" }).click()
  await dialog.waitFor({ state: "hidden", timeout: 5_000 })

  await page.getByRole("button", { name: /Скопировать ссылку|Ссылка скопирована/ }).click()
  const feedbackToast = page.getByTestId("invite-feedback-toast")
  await feedbackToast.waitFor({ state: "visible", timeout: 5_000 })
  const feedbackText = (await feedbackToast.textContent())?.trim() ?? ""
  assert.match(
    feedbackText,
    /Ссылка для подключения скопирована\./,
    `Top-level copy fallback should show visible feedback (${mode})`,
  )

  console.log(`invite flow works in browser (${mode})`)
}

async function waitForConnected(page, label, expectedPath = null) {
  try {
    await waitForStage(page, "Можно разговаривать", 30_000)

    await page.waitForFunction(() => {
      const video = document.querySelector("[data-testid='remote-video']")
      if (!(video instanceof HTMLVideoElement)) {
        return false
      }

      const stream = video.srcObject
      if (!(stream instanceof MediaStream)) {
        return false
      }

      return stream.getTracks().length > 0
    }, undefined, { timeout: 30_000 })
  } catch (error) {
    const snapshot = await page.evaluate(() => {
      const stage = document.querySelector("[data-testid='connection-stage']")?.textContent ?? null
      const errorText = document.querySelector("[data-testid='session-error']")?.textContent ?? null
      const noteText = document.querySelector("[data-testid='session-note']")?.textContent ?? null
      const pathText = document.querySelector("[data-testid='connection-path']")?.textContent ?? null
      const remoteVideo = document.querySelector("[data-testid='remote-video']")
      const remoteTrackCount =
        remoteVideo instanceof HTMLVideoElement && remoteVideo.srcObject instanceof MediaStream
          ? remoteVideo.srcObject.getTracks().length
          : 0

      return { stage, errorText, noteText, pathText, remoteTrackCount }
    })
    throw new Error(`${label} did not connect: ${JSON.stringify(snapshot)}`, { cause: error })
  }

  const connectionPath = await readConnectionPath(page, expectedPath !== null)
  if (expectedPath) {
    assert.equal(connectionPath, expectedPath, `${label} should connect through ${expectedPath}`)
  }

  console.log(`${label}: connected via ${connectionPath}`)
}

async function runScenario(browser, mode) {
  const created = await createSession()
  console.log(`created session ${created.sessionId} (${mode})`)

  const contextOptions = {
    ignoreHTTPSErrors: true,
    permissions: ["camera", "microphone", "clipboard-read", "clipboard-write"],
    locale: "ru-RU",
    viewport: { width: 1440, height: 900 },
  }

  const hostContext = await browser.newContext(contextOptions)
  const guestContext = await browser.newContext(contextOptions)

  try {
    const hostPage = await hostContext.newPage()
    const guestPage = await guestContext.newPage()
    attachPageDebug(hostPage, `host:${mode}`)
    attachPageDebug(guestPage, `guest:${mode}`)

    const expectedPath = mode === "relay" ? "Через запасной канал" : null
    await hostPage.goto(withIceTransport(created.hostUrl, mode), { waitUntil: "networkidle", timeout: 30_000 })
    await assertSupportModeVisibility(hostPage, mode)
    await verifyInviteFlow(hostPage, created.shareUrl, mode)
    await guestPage.goto(withIceTransport(created.shareUrl, mode), { waitUntil: "networkidle", timeout: 30_000 })
    await assertSupportModeVisibility(guestPage, mode)

    await Promise.all([
      waitForConnected(hostPage, `host:${mode}`, expectedPath),
      waitForConnected(guestPage, `guest:${mode}`, expectedPath),
    ])

    assert.equal(
      await hostPage.getByRole("button", { name: "Отправить приглашение" }).isDisabled(),
      true,
      `host invite should be disabled when the call is full (${mode})`,
    )
    assert.equal(
      await guestPage.getByRole("button", { name: "Отправить приглашение" }).isDisabled(),
      true,
      `guest invite should be disabled when the call is full (${mode})`,
    )

    await guestPage.getByRole("button", { name: "Выключить микрофон" }).click()
    await hostPage.getByTestId("remote-audio-muted").waitFor({ state: "visible", timeout: 10_000 })
    console.log(`remote mute indicator works (${mode})`)

    await guestPage.getByRole("button", { name: "Включить микрофон" }).click()
    await hostPage.getByTestId("remote-audio-muted").waitFor({ state: "hidden", timeout: 10_000 })
    console.log(`remote unmute indicator works (${mode})`)

    await guestPage.getByRole("button", { name: "Выйти из звонка" }).click()
    await hostPage.waitForFunction(() => {
      const el = document.querySelector("[data-testid='connection-stage']")
      return el?.textContent?.includes("Ждем собеседника")
    }, undefined, { timeout: 15_000 })
    console.log(`leave flow works in browser (${mode})`)
  } finally {
    await hostContext.close()
    await guestContext.close()
  }
}

async function main() {
  const browser = await chromium.launch({
    headless,
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--ignore-certificate-errors",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  })

  try {
    for (const scenario of scenarios) {
      await runScenario(browser, scenario)
    }
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
