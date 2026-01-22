const express = require("express");
const fs = require("fs");
const path = require("path");
const { marked } = require("marked");
const multer = require("multer");
const cors = require("cors");
const { spawn } = require("child_process");

/* =======================
   BASIC SETUP
======================= */

const app = express();
app.use(cors());
app.use(express.json());

const ROOT = path.join(__dirname, "../../public");

/* =======================
   PATHS
======================= */

const BLOG_JSON = path.join(ROOT, "blog/data/blogs.json");
const POSTS_DIR = path.join(ROOT, "blog/posts");
const SITEMAP = path.join(ROOT, "sitemap.xml");

const BLOG_TEMPLATES = {
  1: path.join(ROOT, "blog/templates/blog-template-1.html"), // default
  2: path.join(ROOT, "blog/templates/blog-template-2.html"),
  3: path.join(ROOT, "blog/templates/blog-template-3.html"),
};

/* =======================
   ENSURE DIRS
======================= */

if (!fs.existsSync(POSTS_DIR)) {
  fs.mkdirSync(POSTS_DIR, { recursive: true });
}
if (!fs.existsSync(path.join(ROOT, "blog/data"))) {
  fs.mkdirSync(path.join(ROOT, "blog/data"), { recursive: true });
}
if (!fs.existsSync(BLOG_JSON)) {
  fs.writeFileSync(BLOG_JSON, "[]");
}

/* =======================
   FILE UPLOAD (MULTER)
======================= */

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(ROOT, "images/blog");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const unique = Date.now() + "-" + file.originalname.replace(/\s+/g, "-");
    cb(null, unique);
  },
});

const upload = multer({ storage });

const uploadFields = upload.fields([
  { name: "cover", maxCount: 1 },
  { name: "thumbnail", maxCount: 1 },
]);

/* =======================
   HELPERS
======================= */

const slugify = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

const readBlogs = () => {
  try {
    return JSON.parse(fs.readFileSync(BLOG_JSON, "utf8"));
  } catch {
    return [];
  }
};

const writeSitemap = (blogs) => {
  const urls = blogs
    .map(
      (b) => `
  <url>
    <loc>https://on-track.in${b.url}</loc>
    <lastmod>${b.date}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>`,
    )
    .join("");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="https://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://on-track.in/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  ${urls}
</urlset>`;

  fs.writeFileSync(SITEMAP, xml);
};

/* =======================
   GIT + DEPLOY
======================= */

function gitAddCommitDeploy(files, title) {
  const cwd = path.join(__dirname, "../../");

  const add = spawn("git", ["add", ...files], { cwd });
  add.on("close", () => {
    const commit = spawn(
      "git",
      ["commit", "-m", `New blog post added: ${title}`],
      { cwd },
    );

    commit.on("close", () => {
      const push = spawn("git", ["push"], { cwd });
      push.on("close", () => {
        const deploy = spawn("firebase", ["deploy", "--only", "hosting"], {
          cwd,
        });
        deploy.stdout.on("data", (d) => console.log(d.toString()));
        deploy.stderr.on("data", (d) => console.error(d.toString()));
      });
    });
  });
}

/* =======================
   ROUTES
======================= */

app.get("/health", (_, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

app.post("/blog/create", uploadFields, (req, res) => {
  const { title, markdown, description, author, tags, template } = req.body;

  if (!title || !markdown) {
    return res.status(400).json({ error: "Title & markdown required" });
  }

  /* ---------- TEMPLATE ---------- */
  const templateId = Number(template);
  const finalTemplateId = BLOG_TEMPLATES[templateId] ? templateId : 1;
  const TEMPLATE_PATH = BLOG_TEMPLATES[finalTemplateId];

  /* ---------- FILES ---------- */
  const coverFile = req.files?.cover?.[0];
  const thumbnailFile = req.files?.thumbnail?.[0];

  const coverPath = coverFile
    ? `/images/blog/${coverFile.filename}`
    : "/images/blog/default.jpg";

  const thumbnailPath = thumbnailFile
    ? `/images/blog/${thumbnailFile.filename}`
    : coverPath;

  /* ---------- BLOG DATA ---------- */
  const slug = slugify(title);
  const blogs = readBlogs();

  if (blogs.some((b) => b.slug === slug)) {
    return res.status(409).json({
      error: "Blog with same title already exists",
    });
  }

  const date = new Date().toISOString().split("T")[0];
  const htmlContent = marked.parse(markdown);

  const blog = {
    title,
    slug,
    description: description || title,
    author: author || "Ontrack Team",
    date,
    url: `/blog/posts/${slug}.html`,
    cover: coverPath,
    thumbnail: thumbnailPath,
    tags: tags ? tags.split(",").map((t) => t.trim()) : [],
    template: finalTemplateId,
  };

  blogs.push(blog);
  fs.writeFileSync(BLOG_JSON, JSON.stringify(blogs, null, 2));

  /* ---------- HTML ---------- */
  let templateHtml = fs.readFileSync(TEMPLATE_PATH, "utf8");

  templateHtml = templateHtml
    .replace(/{{title}}/g, blog.title)
    .replace(/{{description}}/g, blog.description)
    .replace(/{{date}}/g, blog.date)
    .replace(/{{author}}/g, blog.author)
    .replace(/{{cover}}/g, blog.cover)
    .replace(/{{thumbnail}}/g, blog.thumbnail)
    .replace(/{{content}}/g, htmlContent)
    .replace(/{{url}}/g, blog.url)
    .replace(/{{tags}}/g, blog.tags.join(", "));

  const outputFile = path.join(POSTS_DIR, `${slug}.html`);
  fs.writeFileSync(outputFile, templateHtml);

  writeSitemap(blogs);

  /* ---------- DEPLOY ---------- */
  const createdFiles = [outputFile, BLOG_JSON, SITEMAP];
  if (coverFile)
    createdFiles.push(path.join(ROOT, "images/blog", coverFile.filename));
  if (thumbnailFile)
    createdFiles.push(path.join(ROOT, "images/blog", thumbnailFile.filename));

  gitAddCommitDeploy(createdFiles, title);

  res.json({
    success: true,
    page: blog.url,
    template: finalTemplateId,
  });
});

/* =======================
   START
======================= */

app.listen(3333, () =>
  console.log("📝 Blog generator running on http://localhost:3333"),
);
