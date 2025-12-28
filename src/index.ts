#!/usr/bin/env bun
import {
  createCliRenderer,
  FrameBufferRenderable,
  BoxRenderable,
  InputRenderable,
  SelectRenderable,
  RGBA,
  type KeyEvent,
  type MouseEvent,
} from "@opentui/core"
import sharp from "sharp"
import { chromium, type Browser, type Page } from "playwright"
import { spawn } from "child_process"

// Progress bar rendering for terminal
function renderProgressBar(progress: number, width: number = 40): string {
  const filled = Math.round(progress * width)
  const empty = width - filled
  const bar = "█".repeat(filled) + "░".repeat(empty)
  const percentage = Math.round(progress * 100)
  return `[${bar}] ${percentage}%`
}

// Check if Playwright Chromium is installed
async function isChromiumInstalled(): Promise<boolean> {
  try {
    // Try to get the executable path - this throws if not installed
    const browser = await chromium.launch({ headless: true })
    await browser.close()
    return true
  } catch (error) {
    // Check if the error is about browser not being installed
    const errorMessage = String(error)
    if (
      errorMessage.includes("Executable doesn't exist") ||
      errorMessage.includes("browserType.launch") ||
      errorMessage.includes("PLAYWRIGHT_BROWSERS_PATH")
    ) {
      return false
    }
    // For other errors, assume it's installed but there's another issue
    return true
  }
}

// Install Playwright Chromium with progress bar
async function installChromium(): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log("\n🌐 Playwright Chromium browser not found.")
    console.log("📦 Installing Chromium browser...\n")

    let progress = 0
    let lastOutput = ""

    // Start the installation process
    const installProcess = spawn("npx", ["playwright", "install", "chromium"], {
      shell: false,
      stdio: ["inherit", "pipe", "pipe"],
    })

    // Simulate progress based on output and time
    const progressInterval = setInterval(() => {
      if (progress < 0.95) {
        // Increment progress slowly
        progress += 0.02
        process.stdout.write(`\r${renderProgressBar(progress)}  Installing...`)
      }
    }, 200)

    installProcess.stdout?.on("data", (data: Buffer) => {
      lastOutput = data.toString()
      // Speed up progress when we see actual download activity
      if (lastOutput.includes("Downloading") || lastOutput.includes("%")) {
        progress = Math.min(progress + 0.05, 0.9)
      }
    })

    installProcess.stderr?.on("data", (data: Buffer) => {
      const output = data.toString()
      // Playwright outputs progress to stderr
      if (output.includes("%")) {
        // Try to parse percentage from output
        const match = output.match(/(\d+)%/)
        if (match) {
          progress = Math.min(parseInt(match[1], 10) / 100, 0.99)
          process.stdout.write(`\r${renderProgressBar(progress)}  ${output.trim().slice(0, 30)}`)
        }
      }
    })

    installProcess.on("close", (code) => {
      clearInterval(progressInterval)
      if (code === 0) {
        process.stdout.write(`\r${renderProgressBar(1)}  Done!          \n`)
        console.log("\n✅ Chromium browser installed successfully!\n")
        resolve()
      } else {
        console.error(`\n\n❌ Failed to install Chromium (exit code: ${code})`)
        console.error("Please run manually: npx playwright install chromium")
        reject(new Error(`Installation failed with code ${code}`))
      }
    })

    installProcess.on("error", (error) => {
      clearInterval(progressInterval)
      console.error("\n\n❌ Failed to start installation:", error.message)
      reject(error)
    })
  })
}

// Ensure Chromium is installed before starting
async function ensureChromiumInstalled(): Promise<void> {
  process.stdout.write("🔍 Checking for Playwright Chromium... ")

  const installed = await isChromiumInstalled()

  if (installed) {
    console.log("✓ Found!")
    return
  }

  console.log("Not found.")
  await installChromium()
}

// Command palette action definition
interface CommandAction {
  name: string
  description: string
  shortcut?: string
  action: () => void | Promise<void>
}

// Command palette state
let commandPaletteOpen = false
let commandPaletteContainer: BoxRenderable | null = null
let commandInput: InputRenderable | null = null
let commandSelect: SelectRenderable | null = null
let allCommands: CommandAction[] = []

// Scale factor for browser viewport relative to terminal size
const SCALE_FACTOR = 4

// Continuous render frame rate
const RENDER_FPS = 30
const RENDER_INTERVAL_MS = 1000 / RENDER_FPS

// Get URL from command line argument
const url = process.argv[2]
if (!url) {
  console.error("Usage: npx tsx src/index.ts <url>")
  console.error("Example: npx tsx src/index.ts https://example.com")
  process.exit(1)
}

async function main() {
  // Ensure Playwright Chromium is installed
  await ensureChromiumInstalled()

  // Create the CLI renderer first to get terminal dimensions
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 30,
  })

  // Start the renderer first to get terminal dimensions
  renderer.start()

  // Small delay to ensure terminal dimensions are available
  await new Promise((resolve) => setTimeout(resolve, 50))

  const termWidth = renderer.terminalWidth || 80
  const termHeight = renderer.terminalHeight || 24

  console.log(`Terminal size: ${termWidth}x${termHeight}`)

  // Calculate browser viewport size (terminal cells * scale factor)
  // Each terminal cell is roughly 1 char wide, and with half-block rendering
  // we get 2 vertical pixels per cell, so we scale accordingly
  const browserWidth = termWidth * SCALE_FACTOR
  const browserHeight = termHeight * SCALE_FACTOR * 2 // *2 for half-block vertical doubling

  console.log(`Launching browser at ${browserWidth}x${browserHeight}...`)

  // Launch headless Playwright browser
  const browser: Browser = await chromium.launch({ headless: true })
  const page: Page = await browser.newPage({
    viewport: { width: browserWidth, height: browserHeight },
  })

  // Navigate to the specified URL
  console.log(`Loading ${url}...`)
  await page.goto(url, { waitUntil: "domcontentloaded" })

  // Take screenshot
  console.log("Taking screenshot...")
  const screenshotBuffer = await page.screenshot({ type: "png" })

  // Load screenshot with sharp and resize to terminal pixel dimensions
  // Terminal has termWidth x (termHeight * 2) effective pixels (due to half-block rendering)
  const targetWidth = termWidth
  const targetHeight = termHeight * 2
  let pixels = await sharp(screenshotBuffer)
    .resize(targetWidth, targetHeight)
    .raw()
    .ensureAlpha()
    .toBuffer()

  console.log(`Screenshot resized to: ${targetWidth}x${targetHeight}`)

  // Create framebuffer for image rendering
  const framebuffer = new FrameBufferRenderable(renderer, {
    id: "image-screen",
    width: termWidth,
    height: termHeight,
    position: "absolute",
    left: 0,
    top: 0,
    zIndex: 0,
  })
  renderer.root.add(framebuffer)

  // Convert terminal coordinates to browser coordinates
  function termToBrowser(termX: number, termY: number) {
    const currentWidth = renderer.terminalWidth || 80
    const currentHeight = renderer.terminalHeight || 24
    const browserW = currentWidth * SCALE_FACTOR
    const browserH = currentHeight * SCALE_FACTOR * 2
    // Map terminal position to browser position
    const browserX = (termX / currentWidth) * browserW
    const browserY = (termY / currentHeight) * browserH
    return { x: browserX, y: browserY }
  }

  // Attach scroll listener to framebuffer - emit scroll in browser
  framebuffer.onMouseScroll = async (event: MouseEvent) => {
    if (event.scroll) {
      const scrollAmount = event.scroll.delta * 50 // Pixels per scroll tick
      const deltaY =
        event.scroll.direction === "down"
          ? scrollAmount
          : event.scroll.direction === "up"
            ? -scrollAmount
            : 0
      const deltaX =
        event.scroll.direction === "right"
          ? scrollAmount
          : event.scroll.direction === "left"
            ? -scrollAmount
            : 0

      if (deltaX !== 0 || deltaY !== 0) {
        // Use window.scrollBy for more reliable scrolling
        await page.evaluate(
          ({ x, y }) => window.scrollBy(x, y),
          { x: deltaX, y: deltaY }
        )
      }
    }
  }

  // Attach mouse down listener - start click or drag
  framebuffer.onMouseDown = async (event: MouseEvent) => {
    const { x, y } = termToBrowser(event.x, event.y)
    await page.mouse.move(x, y)
    await page.mouse.down()
  }

  // Attach mouse up listener - end click or drag
  framebuffer.onMouseUp = async (event: MouseEvent) => {
    const { x, y } = termToBrowser(event.x, event.y)
    await page.mouse.move(x, y)
    await page.mouse.up()
  }

  // Attach mouse move listener - hover and drag
  framebuffer.onMouseMove = async (event: MouseEvent) => {
    const { x, y } = termToBrowser(event.x, event.y)
    await page.mouse.move(x, y)
  }

  // Function to render image to framebuffer
  // Expects imgPixels to be pre-resized to (width) x (height * 2) by Sharp
  function renderImage(
    width: number,
    height: number,
    imgPixels: Buffer
  ) {
    const fb = framebuffer.frameBuffer
    const imgWidth = width // Image is pre-resized by Sharp

    // Render using half-block characters (▀)
    // Upper half = foreground color, lower half = background color
    // scaleX = 1, scaleY = 1 (Sharp handles resizing)
    for (let y = 0; y < height; y++) {
      const srcY1 = y * 2 // Top pixel row
      const srcY2 = y * 2 + 1 // Bottom pixel row

      for (let x = 0; x < width; x++) {
        // Top pixel (foreground)
        const srcIdx1 = (srcY1 * imgWidth + x) * 4
        const r1 = imgPixels[srcIdx1] ?? 0
        const g1 = imgPixels[srcIdx1 + 1] ?? 0
        const b1 = imgPixels[srcIdx1 + 2] ?? 0

        // Bottom pixel (background)
        const srcIdx2 = (srcY2 * imgWidth + x) * 4
        const r2 = imgPixels[srcIdx2] ?? 0
        const g2 = imgPixels[srcIdx2 + 1] ?? 0
        const b2 = imgPixels[srcIdx2 + 2] ?? 0

        // Use upper half-block: ▀ (foreground = top, background = bottom)
        fb.setCell(x, y, "▀", RGBA.fromInts(r1, g1, b1), RGBA.fromInts(r2, g2, b2))
      }
    }
  }

  // Function to take a new screenshot and update display
  async function refreshScreenshot(width: number, height: number) {
    const newBrowserWidth = width * SCALE_FACTOR
    const newBrowserHeight = height * SCALE_FACTOR * 2

    await page.setViewportSize({ width: newBrowserWidth, height: newBrowserHeight })
    const newScreenshotBuffer = await page.screenshot({ type: "png" })

    // Resize to terminal pixel dimensions (width x height*2) using Sharp
    pixels = await sharp(newScreenshotBuffer)
      .resize(width, height * 2)
      .raw()
      .ensureAlpha()
      .toBuffer()

    renderImage(width, height, pixels)
  }

  // Initial render
  renderImage(termWidth, termHeight, pixels)

  // Track current URL for display
  let currentUrl = url

  // Define all available commands
  allCommands = [
    {
      name: "Go Back",
      description: "Navigate to previous page",
      shortcut: "Alt+←",
      action: async () => {
        await page.goBack()
        currentUrl = page.url()
      },
    },
    {
      name: "Go Forward",
      description: "Navigate to next page",
      shortcut: "Alt+→",
      action: async () => {
        await page.goForward()
        currentUrl = page.url()
      },
    },
    {
      name: "Refresh Page",
      description: "Reload the current page",
      shortcut: "Ctrl+R",
      action: async () => {
        await page.reload()
      },
    },
    {
      name: "Go to URL",
      description: "Navigate to a new URL",
      shortcut: "Ctrl+L",
      action: () => {
        openUrlInput()
      },
    },
    {
      name: "Scroll to Top",
      description: "Scroll to the top of the page",
      shortcut: "Home",
      action: async () => {
        await page.evaluate(() => window.scrollTo(0, 0))
      },
    },
    {
      name: "Scroll to Bottom",
      description: "Scroll to the bottom of the page",
      shortcut: "End",
      action: async () => {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      },
    },
    {
      name: "Page Up",
      description: "Scroll up one page",
      shortcut: "PgUp",
      action: async () => {
        await page.evaluate(() => window.scrollBy(0, -window.innerHeight))
      },
    },
    {
      name: "Page Down",
      description: "Scroll down one page",
      shortcut: "PgDn",
      action: async () => {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight))
      },
    },
    {
      name: "Zoom In",
      description: "Increase page zoom",
      shortcut: "Ctrl++",
      action: async () => {
        await page.evaluate(() => {
          document.body.style.zoom = String(parseFloat(document.body.style.zoom || "1") + 0.1)
        })
      },
    },
    {
      name: "Zoom Out",
      description: "Decrease page zoom",
      shortcut: "Ctrl+-",
      action: async () => {
        await page.evaluate(() => {
          document.body.style.zoom = String(Math.max(0.1, parseFloat(document.body.style.zoom || "1") - 0.1))
        })
      },
    },
    {
      name: "Reset Zoom",
      description: "Reset page zoom to 100%",
      shortcut: "Ctrl+0",
      action: async () => {
        await page.evaluate(() => {
          document.body.style.zoom = "1"
        })
      },
    },
    {
      name: "Copy Current URL",
      description: "Copy the current page URL",
      shortcut: "Ctrl+Shift+C",
      action: async () => {
        // In terminal we can't easily copy to clipboard, so just show it
        currentUrl = page.url()
      },
    },
    {
      name: "Screenshot",
      description: "Take a full-page screenshot",
      action: async () => {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
        const filename = `screenshot-${timestamp}.png`
        await page.screenshot({ path: filename, fullPage: true })
      },
    },
    {
      name: "Toggle JavaScript",
      description: "Block all JavaScript on this page",
      action: async () => {
        await page.route("**/*", (route) => {
          if (route.request().resourceType() === "script") {
            route.abort()
          } else {
            route.continue()
          }
        })
        await page.reload()
      },
    },
    {
      name: "Clear Cookies",
      description: "Clear all cookies for this site",
      action: async () => {
        const context = page.context()
        await context.clearCookies()
        await page.reload()
      },
    },
    {
      name: "Quit",
      description: "Exit the browser",
      shortcut: "Ctrl+Q",
      action: async () => {
        clearInterval(renderLoop)
        await browser.close()
        renderer.stop()
        process.exit(0)
      },
    },
  ]

  // URL input state
  let urlInputOpen = false
  let urlInputContainer: BoxRenderable | null = null
  let urlInput: InputRenderable | null = null

  // Open URL input dialog
  function openUrlInput() {
    if (urlInputOpen) return
    urlInputOpen = true

    const w = renderer.terminalWidth || 80
    const h = renderer.terminalHeight || 24
    const modalWidth = Math.min(60, w - 4)
    const modalHeight = 3
    const modalX = Math.floor((w - modalWidth) / 2)
    const modalY = Math.floor((h - modalHeight) / 2)

    urlInputContainer = new BoxRenderable(renderer, {
      id: "url-input-container",
      position: "absolute",
      left: modalX,
      top: modalY,
      width: modalWidth,
      height: modalHeight,
      backgroundColor: "#1a1a2e",
      border: true,
      borderStyle: "rounded",
      borderColor: "#4a9eff",
      title: " Go to URL ",
      titleAlignment: "center",
      zIndex: 100,
    })

    urlInput = new InputRenderable(renderer, {
      id: "url-input",
      position: "absolute",
      left: 1,
      top: 0,
      width: modalWidth - 4,
      height: 1,
      backgroundColor: "#1a1a2e",
      textColor: "#ffffff",
      focusedBackgroundColor: "#1a1a2e",
      focusedTextColor: "#ffffff",
      placeholder: "Enter URL...",
      placeholderColor: "#666666",
      value: currentUrl,
    })

    urlInputContainer.add(urlInput)
    renderer.root.add(urlInputContainer)
    urlInput.focus()
  }

  // Close URL input dialog
  function closeUrlInput() {
    if (!urlInputOpen) return
    urlInputOpen = false

    if (urlInputContainer) {
      renderer.root.remove(urlInputContainer.id)
      urlInputContainer = null
      urlInput = null
    }
  }

  // Open command palette
  function openCommandPalette() {
    if (commandPaletteOpen) return
    commandPaletteOpen = true

    const w = renderer.terminalWidth || 80
    const h = renderer.terminalHeight || 24
    const modalWidth = Math.min(50, w - 4)
    const modalHeight = Math.min(16, h - 4)
    const modalX = Math.floor((w - modalWidth) / 2)
    const modalY = Math.floor((h - modalHeight) / 2)

    commandPaletteContainer = new BoxRenderable(renderer, {
      id: "command-palette",
      position: "absolute",
      left: modalX,
      top: modalY,
      width: modalWidth,
      height: modalHeight,
      backgroundColor: "#1a1a2e",
      border: true,
      borderStyle: "rounded",
      borderColor: "#4a9eff",
      title: " Command Palette ",
      titleAlignment: "center",
      zIndex: 100,
    })

    commandInput = new InputRenderable(renderer, {
      id: "command-input",
      position: "absolute",
      left: 1,
      top: 0,
      width: modalWidth - 4,
      height: 1,
      backgroundColor: "#252545",
      textColor: "#ffffff",
      focusedBackgroundColor: "#252545",
      focusedTextColor: "#ffffff",
      placeholder: "Type to search commands...",
      placeholderColor: "#666666",
    })

    // Listen for input changes to filter commands
    commandInput.on("input", () => {
      if (commandInput) {
        filterCommands(commandInput.value)
      }
    })

    commandSelect = new SelectRenderable(renderer, {
      id: "command-select",
      position: "absolute",
      left: 1,
      top: 2,
      width: modalWidth - 4,
      height: modalHeight - 5,
      backgroundColor: "#1a1a2e",
      textColor: "#cccccc",
      selectedBackgroundColor: "#4a9eff",
      selectedTextColor: "#ffffff",
      descriptionColor: "#888888",
      selectedDescriptionColor: "#dddddd",
      showDescription: true,
      wrapSelection: true,
      options: allCommands.map((cmd) => ({
        name: cmd.shortcut ? `${cmd.name}  (${cmd.shortcut})` : cmd.name,
        description: cmd.description,
        value: cmd,
      })),
    })

    commandPaletteContainer.add(commandInput)
    commandPaletteContainer.add(commandSelect)
    renderer.root.add(commandPaletteContainer)
    commandInput.focus()
  }

  // Close command palette
  function closeCommandPalette() {
    if (!commandPaletteOpen) return
    commandPaletteOpen = false

    if (commandPaletteContainer) {
      renderer.root.remove(commandPaletteContainer.id)
      commandPaletteContainer = null
      commandInput = null
      commandSelect = null
    }
  }

  // Filter commands based on search term
  function filterCommands(searchTerm: string) {
    if (!commandSelect) return

    const filtered = allCommands.filter((cmd) => {
      const term = searchTerm.toLowerCase()
      return (
        cmd.name.toLowerCase().includes(term) ||
        cmd.description.toLowerCase().includes(term)
      )
    })

    commandSelect.options = filtered.map((cmd) => ({
      name: cmd.shortcut ? `${cmd.name}  (${cmd.shortcut})` : cmd.name,
      description: cmd.description,
      value: cmd,
    }))
  }

  // Execute selected command
  async function executeSelectedCommand() {
    if (!commandSelect) return

    const selected = commandSelect.getSelectedOption()
    if (selected && selected.value) {
      closeCommandPalette()
      await selected.value.action()
    }
  }

  // Continuous render loop at 5fps
  const renderLoop = setInterval(async () => {
    const w = renderer.terminalWidth || 80
    const h = renderer.terminalHeight || 24
    await refreshScreenshot(w, h)
  }, RENDER_INTERVAL_MS)

  // Handle resize - take new screenshot at new size
  renderer.on("resize", async (width, height) => {
    framebuffer.frameBuffer.resize(width, height)
    await refreshScreenshot(width, height)
  })

  // Map terminal key names to Playwright key names
  const keyNameMap: Record<string, string> = {
    return: "Enter",
    enter: "Enter",
    backspace: "Backspace",
    delete: "Delete",
    tab: "Tab",
    up: "ArrowUp",
    down: "ArrowDown",
    left: "ArrowLeft",
    right: "ArrowRight",
    home: "Home",
    end: "End",
    pageup: "PageUp",
    pagedown: "PageDown",
    space: " ",
  }

  // Handle keyboard events
  renderer.keyInput.on("keypress", async (key: KeyEvent) => {
    // Handle URL input mode
    if (urlInputOpen && urlInput) {
      if (key.name === "escape") {
        closeUrlInput()
        return
      }
      if (key.name === "return" || key.name === "enter") {
        const newUrl = urlInput.value.trim()
        if (newUrl) {
          closeUrlInput()
          // Add protocol if missing
          const finalUrl = newUrl.match(/^https?:\/\//) ? newUrl : `https://${newUrl}`
          await page.goto(finalUrl, { waitUntil: "domcontentloaded" })
          currentUrl = page.url()
        }
        return
      }
      // Don't forward to browser - focused input handles typing automatically
      return
    }

    // Handle command palette mode
    if (commandPaletteOpen) {
      if (key.name === "escape") {
        closeCommandPalette()
        return
      }

      if (key.name === "return" || key.name === "enter") {
        await executeSelectedCommand()
        return
      }

      if (key.name === "up") {
        commandSelect?.moveUp()
        return
      }

      if (key.name === "down") {
        commandSelect?.moveDown()
        return
      }

      if (key.name === "tab") {
        // Tab also moves down for convenience
        if (key.shift) {
          commandSelect?.moveUp()
        } else {
          commandSelect?.moveDown()
        }
        return
      }

      // Don't forward to browser - focused input handles typing automatically
      return
    }

    // Open command palette with Ctrl+K or Meta+K (Cmd+K on Mac)
    if ((key.ctrl || key.meta) && key.name === "k") {
      openCommandPalette()
      return
    }

    // Shortcut: Ctrl+L to open URL input
    if (key.ctrl && key.name === "l") {
      openUrlInput()
      return
    }

    // Shortcut: Ctrl+R to refresh
    if (key.ctrl && key.name === "r") {
      await page.reload()
      return
    }

    // Shortcut: Ctrl+Q to quit
    if (key.ctrl && key.name === "q") {
      clearInterval(renderLoop)
      await browser.close()
      renderer.stop()
      process.exit(0)
    }

    // Exit on Escape or Ctrl+C
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      clearInterval(renderLoop)
      await browser.close()
      renderer.stop()
      process.exit(0)
    }

    // Forward keyboard input to browser
    const playwrightKey = keyNameMap[key.name ?? ""]

    if (playwrightKey) {
      // Special key - use press
      await page.keyboard.press(playwrightKey)
    } else if (key.sequence && key.sequence.length === 1) {
      // Regular character - type it
      await page.keyboard.type(key.sequence)
    } else if (key.name && key.name.length === 1) {
      // Single character key name
      await page.keyboard.type(key.name)
    }
  })
}

main().catch(console.error)
