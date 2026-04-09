const express = require("express");
const { chromium } = require("playwright");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get("/", (_req, res) => {
  res.send("Clearscope Creeper is running.");
});

// Debug endpoint: dumps raw HTML from Research and Outline tabs
app.post("/debug", async (req, res) => {
  const { url } = req.body;
  if (!url || !url.includes("clearscope.io")) {
    return res.status(400).json({ error: "A valid Clearscope editor URL is required." });
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });

    // Click Research tab
    const researchTab = await page.locator('nav[role="tablist"] button', { hasText: "Research" });
    await researchTab.click();
    await page.waitForTimeout(3000);

    const researchHTML = await page.evaluate(() => {
      const pane = document.querySelector("[data-tab-pane-active-value='true']");
      return pane ? pane.innerHTML : "NO ACTIVE PANE FOUND";
    });

    // Click Outline tab
    const outlineTab = await page.locator('nav[role="tablist"] button', { hasText: "Outline" });
    await outlineTab.click();
    await page.waitForTimeout(3000);

    const outlineHTML = await page.evaluate(() => {
      const pane = document.querySelector("[data-tab-pane-active-value='true']");
      return pane ? pane.innerHTML : "NO ACTIVE PANE FOUND";
    });

    await browser.close();

    res.json({ researchHTML, outlineHTML });
  } catch (err) {
    if (browser) await browser.close();
    res.status(500).json({ error: err.message });
  }
});

// Main extraction endpoint
app.post("/extract", async (req, res) => {
  const { url } = req.body;
  if (!url || !url.includes("clearscope.io")) {
    return res.status(400).json({ error: "A valid Clearscope editor URL is required." });
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });

    // --- Extract terms ---
    const terms = await page.evaluate(() => {
      const termEls = document.querySelectorAll("[data-editor-target='term']");
      return Array.from(termEls).map((el) => {
        const vals = JSON.parse(el.getAttribute("data-sortable-values") || "{}");
        const usesText = el.querySelector(".text-on-surface-variant.text-xs");
        const usesMatch = usesText
          ? usesText.textContent.match(/Typical uses:\s*(\d+)-(\d+)/)
          : null;
        return {
          term: vals.primary_variant || "",
          importance: vals.importance || 0,
          used: vals.used || false,
          aiPresence: vals.answer_engine_match_value || 0,
          typicalUsesMin: usesMatch ? parseInt(usesMatch[1]) : null,
          typicalUsesMax: usesMatch ? parseInt(usesMatch[2]) : null,
        };
      });
    });

    // --- Extract content grade info ---
    const meta = await page.evaluate(() => {
      const text = document.querySelector("[data-frame='evaluation']")?.textContent || "";
      const wordCountMatch = text.match(/Word count\s*(\d[\d,]*)/);
      const readabilityMatch = text.match(/Readability\s*([\w\s-]+?)(?:Typical|$)/);
      return {
        wordCount: wordCountMatch ? wordCountMatch[1].replace(",", "") : "0",
        readability: readabilityMatch ? readabilityMatch[1].trim() : "",
      };
    });

    // --- Click Research tab and extract questions ---
    const researchTab = await page.locator('nav[role="tablist"] button', { hasText: "Research" });
    await researchTab.click();
    await page.waitForTimeout(3000);

    const questions = await page.evaluate(() => {
      const activePane = document.querySelector("[data-tab-pane-active-value='true']");
      if (!activePane) return [];
      const items = activePane.querySelectorAll("li, [class*='question'], p, div.text-sm");
      const found = [];
      items.forEach((item) => {
        const t = item.textContent.trim();
        if (t && t.endsWith("?")) found.push(t);
      });
      return [...new Set(found)];
    });

    // --- Click Outline tab and extract competitor headings ---
    const outlineTab = await page.locator('nav[role="tablist"] button', { hasText: "Outline" });
    await outlineTab.click();
    await page.waitForTimeout(3000);

    const outline = await page.evaluate(() => {
      const activePane = document.querySelector("[data-tab-pane-active-value='true']");
      if (!activePane) return [];
      const competitors = [];
      const sections = activePane.querySelectorAll("[class*='vstack'], [class*='competitor'], details, section");
      if (sections.length === 0) {
        return [{ raw: activePane.innerText }];
      }
      sections.forEach((sec) => {
        const title = sec.querySelector("h3, h4, h5, [class*='font-semibold'], summary");
        const headings = sec.querySelectorAll("[class*='heading'], li, [class*='outline']");
        if (title || headings.length > 0) {
          competitors.push({
            title: title ? title.textContent.trim() : "",
            headings: Array.from(headings).map((h) => h.textContent.trim()).filter(Boolean),
          });
        }
      });
      return competitors.length > 0 ? competitors : [{ raw: activePane.innerText }];
    });

    await browser.close();

    res.json({
      status: "success",
      data: { terms, questions, outline, meta },
    });
  } catch (err) {
    if (browser) await browser.close();
    console.error("Extraction failed:", err.message);
    res.status(500).json({ error: "Extraction failed", detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Clearscope Creeper listening on port ${PORT}`);
});
