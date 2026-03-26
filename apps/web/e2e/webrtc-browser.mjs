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
  if (mode !== "relay") {
    return url
  }

  const nextUrl = new URL(url)
  nextUrl.searchParams.set("iceTransport", "relay")
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

async function waitForConnected(page, label, expectedPath = null) {
  try {
    await page.getByTestId("connection-stage").waitFor({ state: "visible", timeout: 20_000 })
    await page.waitForFunction(() => {
      const el = document.querySelector("[data-testid='connection-stage']")
      return el?.textContent?.includes("Соединение активно")
    }, undefined, { timeout: 30_000 })

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

    const expectedPath = mode === "relay" ? "TURN relay" : null
    await hostPage.goto(withIceTransport(created.hostUrl, mode), { waitUntil: "networkidle", timeout: 30_000 })
    await guestPage.goto(withIceTransport(created.shareUrl, mode), { waitUntil: "networkidle", timeout: 30_000 })

    await Promise.all([
      waitForConnected(hostPage, `host:${mode}`, expectedPath),
      waitForConnected(guestPage, `guest:${mode}`, expectedPath),
    ])

    await guestPage.getByRole("button", { name: "Выключить микрофон" }).click()
    await hostPage.getByTestId("remote-audio-muted").waitFor({ state: "visible", timeout: 10_000 })
    console.log(`remote mute indicator works (${mode})`)

    await guestPage.getByRole("button", { name: "Включить микрофон" }).click()
    await hostPage.getByTestId("remote-audio-muted").waitFor({ state: "hidden", timeout: 10_000 })
    console.log(`remote unmute indicator works (${mode})`)

    await guestPage.getByRole("button", { name: "Покинуть сессию" }).click()
    await hostPage.waitForFunction(() => {
      const el = document.querySelector("[data-testid='connection-stage']")
      return el?.textContent?.includes("Ждем второго участника")
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
