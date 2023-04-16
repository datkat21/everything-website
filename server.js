import express from "express";
import { fileURLToPath } from "url";
import path from "node:path";
import fs from "fs";
import { promisify } from "util";
import dotenv from "dotenv";
import { Configuration, OpenAIApi } from "openai";
import { mkdirp } from "mkdirp";
import sqlite3 from "sqlite3";

const sqlite = sqlite3.verbose();
const db = new sqlite.Database("db.sqlite");

const run = promisify(db.run.bind(db));
const get = promisify(db.get.bind(db));
const all = promisify(db.all.bind(db));

db.serialize(() => {
  run(
    "CREATE TABLE IF NOT EXISTS pages (url TEXT PRIMARY KEY, ext TEXT NOT NULL, content TEXT NOT NULL)"
  ).catch(console.error);
});

async function savePage(url, extension, content) {
  try {
    const result = await run(
      "INSERT INTO pages (url, ext, content) VALUES (?, ?, ?)",
      [url, extension, content]
    );
    return true;
  } catch (error) {
    console.error(error.message);
    return false;
  }
}

async function getPage(url) {
  try {
    const row = await get("SELECT content FROM pages WHERE url = ?", [url]);
    if (row) {
      return row.content;
    } else {
      return false;
    }
  } catch (error) {
    console.error(error.message);
    return false;
  }
}

async function getAllPages() {
  try {
    const row = await all("SELECT * FROM pages");
    return row;
  } catch (error) {
    console.error(error.message);
    return false;
  }
}

function fixUpPage(content) {
  try {
    return `<!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta http-equiv="X-UA-Compatible" content="IE=edge" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>${content
        .split("\n")[0]
        .replace(/<!--/g, "")
        .replace(/-->/g, "")
        .trim()}</title>
    </head>
    <body><!--${content}${content.endsWith("</body>") === true ? "" : "</body>"}
  </html>`;
  } catch (e) {
    console.error(e);
    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="X-UA-Compatible" content="IE=edge" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>The Everything Site</title>
  </head>
  <body>${content}
</html>`;
  }
}

dotenv.config();

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.resolve(path.dirname(__filename));

const app = express();

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

app.get("/all", async (req, res) => {
  res.json(await getAllPages());
});

app.get("/goto", (req, res) => {
  if (req.query && typeof req.query.redir !== undefined) {
    return res.redirect(req.query.redir);
  }
  res.json(req.query);
});

const fileLookup = {
  html: {
    prompt: `Create a HTML document with content that matches this URL path: \`$\` Add href links to related topics AND relative/related pages to this path. DON'T use relative folders \`../../\`, instead use absolute links. If you don't know about the topic, make up your own content. The first line should be the title, and the rest is the HTML. You are writing this page for The Everything Website, an attempt to automatically generate pages based on AI prompts. The first line should be a HTML comment that is concise for the title of the page that would go in the \`<title>\` tag. The second line should be a basic description of the page, ending the comment. The rest should ONLY be what is inside the \`<body>\` tag. You must also add a \`<style>\` tag containing some CSS styles to apply to elements within your document to make them appear more intriguing. Also remember to not set font-family per element, and instead set \`font-family\`, \`color\`, and \`background-color\` on \`html, body\`.\n\n<body><!--`,
    getPrompt: function (filePath) {
      return this.prompt.replace("$", filePath);
    },
  },
};

app.get("/*", async (req, res) => {
  const faviconRoute = "/favicon.ico";
  if (req.url === faviconRoute) {
    return res.status(204).end();
  }

  // Determine the path to the file
  let fileUrl = req.url === "/" ? "/index.html" : req.url;

  if (!fileUrl.endsWith("/index.html"))
    fileUrl = path.join(fileUrl, "/index.html").replace(/\\/g, "/");

  const data = await getPage(fileUrl);

  if (data === false) {
    let extension = path.extname(fileUrl).substring(1) || "html";
    const isValid = fileLookup.hasOwnProperty(extension);

    if (!isValid) extension = "html";

    if (!fileLookup[extension])
      return res.send(
        'unable to find details for "' + extension + '" file type'
      );

    const messages = [
      {
        role: "system",
        content: fileLookup[extension].getPrompt(req.url),
      },
    ];

    const resp = await openai
      .createChatCompletion({
        messages,
        model: "gpt-3.5-turbo",
        temperature: 1,
        max_tokens: 2048,
        top_p: 1,
        frequency_penalty: 0,
        presence_penalty: 0,
      })
      .catch((e) => e);
    if (resp instanceof Error) {
      console.error(resp);
      res.status(500).send(`Failed to generate response: ${resp.message}`);
    } else if (resp?.data?.choices?.[0]?.message?.content) {
      const response = resp.data.choices[0].message.content;

      // save
      await savePage(fileUrl, extension, response);
      res.redirect(fileUrl);
    } else {
      console.log("oops", resp, resp?.data?.choices[0]);
      res
        .status(500)
        .send("Failed to generate response: Unknown error occurred");
    }
  } else {
    res
      .header({
        "content-type": "text/html",
      })
      .send(fixUpPage(data));
  }

  res.end();
});

app.listen(8080, (_) => console.log("Listening on port 8080."));
