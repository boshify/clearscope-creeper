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

    const researchTab = await page.locator('nav[role="tablist"] button', { hasText: "Research" });
    await researchTab.click();
    await page.waitForTimeout(3000);

    const researchHTML = await page.evaluate(() => {
      const pane = document.querySelector("[data-tab-pane-active-value='true']");
      return pane ? pane.innerHTML : "NO ACTIVE PANE FOUND";
    });

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

        // Secondary variants are in the hidden dropdown panel
        let secondaryVariants = "";
        const dropdown = el.querySelector("[data-dropdown-target='container']");
        if (dropdown) {
          const italicEl = dropdown.querySelector(".italic.text-on-surface-variant");
          if (italicEl) secondaryVariants = italicEl.textContent.trim();
        }

        return {
          term: vals.primary_variant || "",
          importance: vals.importance || 0,
          used: vals.used || false,
          aiPresence: vals.answer_engine_match_value || 0,
          typicalUsesMin: usesMatch ? parseInt(usesMatch[1]) : null,
          typicalUsesMax: usesMatch ? parseInt(usesMatch[2]) : null,
          secondaryVariants,
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

      // Questions are in <ul class="vstack gap-2 ms-2"> > <li> > first <div>
      const questionList = activePane.querySelector("ul.vstack");
      if (questionList) {
        const items = questionList.querySelectorAll("li");
        return Array.from(items)
          .map((li) => {
            const div = li.querySelector("div");
            return div ? div.textContent.trim() : "";
          })
          .filter(Boolean);
      }

      // Fallback: try clipboard template which has clean <li> elements
      const template = activePane.querySelector("template[data-clipboard-target='source']");
      if (template) {
        const items = template.content.querySelectorAll("li");
        return Array.from(items).map((li) => li.textContent.trim()).filter(Boolean);
      }

      return [];
    });

    // --- Click Outline tab and extract competitor headings ---
    const outlineTab = await page.locator('nav[role="tablist"] button', { hasText: "Outline" });
    await outlineTab.click();
    await page.waitForTimeout(3000);

    // First expand all collapsed sections
    await page.evaluate(() => {
      const expandBtns = document.querySelectorAll("[data-tab-pane-active-value='true'] button[data-action='display#flip']");
      expandBtns.forEach((btn) => btn.click());
    });
    await page.waitForTimeout(500);

    const outline = await page.evaluate(() => {
      const activePane = document.querySelector("[data-tab-pane-active-value='true']");
      if (!activePane) return [];

      // Each competitor is an <li class="mb-6"> inside a <ul>
      const competitorEls = activePane.querySelectorAll("ul > li.mb-6");
      if (competitorEls.length === 0) return [{ raw: activePane.innerText }];

      return Array.from(competitorEls).map((li) => {
        // Title: <a class="link-primary">
        const titleEl = li.querySelector("a.link-primary");
        const title = titleEl ? titleEl.textContent.trim() : "";
        const url = titleEl ? titleEl.href : "";

        // Rankings: <span> badges containing "#N desktop" / "#N mobile"
        const badges = li.querySelectorAll("span.inline-flex.items-center.gap-1");
        const rankings = {};
        badges.forEach((badge) => {
          const text = badge.textContent.trim();
          const match = text.match(/#(\d+)\s+(desktop|mobile)/);
          if (match) rankings[match[2]] = parseInt(match[1]);
        });

        // Word count: <span> containing "N,NNN words"
        const wordSpan = li.querySelector("span.text-on-surface-variant.whitespace-nowrap");
        const wordCount = wordSpan ? wordSpan.textContent.trim().replace(" words", "") : "";

        // Grade: <span> with class containing "text-on-content-grade"
        const gradeEl = li.querySelector("span.text-on-content-grade, [class*='content-grade']");
        const grade = gradeEl ? gradeEl.textContent.trim() : "";

        // Headings: <div class="flex items-baseline mb-2"> with <strong> for level and <span> for text
        const headingEls = li.querySelectorAll("div.flex.items-baseline");
        const headings = Array.from(headingEls).map((h) => {
          const levelEl = h.querySelector("strong");
          const textEl = h.querySelector("span.ps-2");
          return {
            level: levelEl ? levelEl.textContent.trim() : "",
            text: textEl ? textEl.textContent.trim() : "",
          };
        }).filter((h) => h.level && h.text);

        return { title, url, rankings, wordCount, grade, headings };
      });
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
