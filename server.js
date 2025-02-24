import express from "express";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { WebSocket, WebSocketServer } from "ws";
import http from "http";
import puppeteer from "puppeteer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const port = 3000;

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

let browser = null;
let page = null;
let isInitializing = false;

async function initPuppeteer() {
  if (isInitializing) return;
  try {
    isInitializing = true;
    console.log("开始初始化 Puppeteer...");

    // 如果已存在浏览器实例，先关闭它
    if (browser) {
      await browser.close();
      browser = null;
      page = null;
    }
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
      protocolTimeout: 30000,
      timeout: 30000,
    });

    page = await browser.newPage();
    await page.setDefaultNavigationTimeout(30000);
    await page.setDefaultTimeout(30000);
    await page.setViewport({ width: 1260, height: 919 });
    // 等待页面完全加载
    await page.goto("http://localhost:3000/render.html", {
      waitUntil: "networkidle0",
    });
    console.log("Puppeteer 初始化成功");
    return true;
  } catch (error) {
    console.error("Puppeteer 初始化错误:", error);
    // 如果浏览器已创建，则关闭它
    if (browser) {
      await browser.close();
      browser = null;
    }
    page = null;
    return false;
  } finally {
    isInitializing = false;
  }
}

wss.on("connection", async (ws) => {
  console.log("Client connected");

  // 添加重试机制
  let retryCount = 0;
  const maxRetries = 3;

  async function tryInitPuppeteer() {
    if (!browser || !page) {
      const success = await initPuppeteer();
      if (!success && retryCount < maxRetries) {
        console.log(`初始化失败，${retryCount + 1}秒后重试...`);
        retryCount++;
        await new Promise(resolve => setTimeout(resolve, retryCount * 1000));
        return tryInitPuppeteer();
      }
      return success;
    }
    return true;
  }

  // 尝试初始化
  const initialized = await tryInitPuppeteer();
  if (!initialized) {
    console.error('Puppeteer 初始化失败，无法继续运行');
    ws.close();
    return;
  }

  // 从服务端发送场景更新到客户端
  const renderInterval = setInterval(async () => {
    try {
      if (!page) {
        console.log("Page 对象不存在，尝试重新初始化");
        const success = await tryInitPuppeteer();
        if (!success) return;
      }
      const screenshot = await page.screenshot({
        encoding: "base64",
      });
      // 向所有客户端广播渲染结果
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: "render", data: screenshot }));
        }
      });
    } catch (error) {
      console.error("Screenshot error:", error);
      // 如果截图失败，尝试重新初始化
      if (!isInitializing) {
        initPuppeteer();
      }
    }
  }, 1000 / 30);

  // 添加按键转换函数
  const getKeyName = (key) => {
    // 特殊按键映射
    const keyMap = {
      Process: "Enter", // 将输入法的 Process 键映射为 Enter
      Control: "ControlLeft",
      Shift: "ShiftLeft",
      Alt: "AltLeft",
      Meta: "MetaLeft",
    };
    return keyMap[key] || key;
  };

  // 将数字按钮值转换为 Puppeteer 支持的字符串
  const getButtonType = (button) => {
    switch (button) {
      case 0:
        return "left";
      case 1:
        return "middle";
      case 2:
        return "right";
      default:
        return "left";
    }
  };

  // 处理来自客户端的交互事件
  ws.on("message", async (message) => {
    try {
      const event = JSON.parse(message);
      if (event.type === "interaction") {
        if (event.data.type === "input") {
          // 处理 input 输入事件
          await page.evaluate((data) => {
            const element = document.querySelector(data.selector);
            if (element) {
              element.value = data.value;
              // 触发 input 事件
              const inputEvent = new Event("input", { bubbles: true });
              element.dispatchEvent(inputEvent);
              // 触发 change 事件
              const changeEvent = new Event("change", { bubbles: true });
              element.dispatchEvent(changeEvent);
            }
          }, event.data);
        } else if (event.data.type === "keydown") {
          await page.keyboard.down(getKeyName(event.data.key));
        } else if (event.data.type === "keyup") {
          await page.keyboard.up(getKeyName(event.data.key));
        }
        // 处理鼠标按下事件
        else if (event.data.type === "mousedown") {
          await page.mouse.down({ button: getButtonType(event.data.button) });
        }
        // 处理鼠标释放事件
        else if (event.data.type === "mouseup") {
          await page.mouse.up({ button: getButtonType(event.data.button) });
        }
        // 处理鼠标移动事件
        else if (event.data.type === "mousemove") {
          await page.mouse.move(event.data.x, event.data.y);
        }
        // 处理鼠标滚轮事件
        else if (event.data.type === "wheel") {
          await page.mouse.wheel({ deltaY: event.data.deltaY });
        }
      } else if (event.type === "serverMethod") {
        // 处理来自 render.html 的方法调用
        switch (event.method) {
          case "createInput":
            console.log("收到创建输入框请求");
            // 广播给所有客户端
            wss.clients.forEach((client) => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(
                  JSON.stringify({
                    type: "createInput",
                    data: event.data,
                  })
                );
              }
            });
            break;
          case "syncInput":
            // 将输入内容同步到 render.html
            await page.evaluate((data) => {
              const input = document.querySelector("#" + data.id);
              if (input) {
                input.value = data.value;
              }
            }, event.data);
            break;
        }
      }
    } catch (error) {
      console.error("Event processing error:", error);
    }
  });

  ws.on("close", () => {
    clearInterval(renderInterval);
    console.log("Client disconnected");
  });
});

process.on("SIGINT", async () => {
  if (browser) {
    await browser.close();
  }
  process.exit();
});

app.use(express.static("public"));

// 使用server.listen代替app.listen，确保WebSocket和HTTP服务器使用相同的端口
server.listen(port, () => {
  console.log(`服务器运行在 http://localhost:${port}`);
});
