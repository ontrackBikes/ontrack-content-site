const express = require("express");
const fs = require("fs");
const path = require("path");
const { marked } = require("marked");
const multer = require("multer");
const cors = require("cors");

// Folder to store uploaded images
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dir = path.join(ROOT, "images/blog");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix =
      Date.now() + "-" + file.originalname.replace(/\s+/g, "-");
    cb(null, uniqueSuffix);
  },
});

const upload = multer({ storage: storage });

const { spawn } = require("child_process");

function gitAddCommitDeploy(files, title) {
  const add = spawn("git", ["add", ...files], {
    cwd: path.join(__dirname, "../../"),
  });

  add.on("close", (code) => {
    if (code !== 0) return console.error("Git add failed");

    const commit = spawn(
      "git",
      ["commit", "-m", `New blog post added: ${title}`],
      { cwd: path.join(__dirname, "../../") },
    );

    commit.on("close", (code) => {
      if (code !== 0) return console.error("Git commit failed");

      const push = spawn("git", ["push"], {
        cwd: path.join(__dirname, "../../"),
      });

      push.on("close", (code) => {
        if (code !== 0) return console.error("Git push failed");

        // Firebase deploy only hosting
        const deploy = spawn("firebase", ["deploy", "--only", "hosting"], {
          cwd: path.join(__dirname, "../../"),
        });
        deploy.stdout.on("data", (data) => console.log(data.toString()));
        deploy.stderr.on("data", (data) => console.error(data.toString()));
      });
    });
  });
}

const app = express();
app.use(cors());
app.use(express.json());

const ROOT = path.join(__dirname, "../../public");

const BLOG_JSON = path.join(ROOT, "blog/data/blogs.json");
const POSTS_DIR = path.join(ROOT, "blog/posts");
const TEMPLATE = path.join(ROOT, "blog/templates/blog-template.html");
const SITEMAP = path.join(ROOT, "sitemap.xml");

if (!fs.existsSync(POSTS_DIR)) {
  fs.mkdirSync(POSTS_DIR, { recursive: true });
}

const slugify = (t) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

const readBlogs = () => {
  if (!fs.existsSync(BLOG_JSON)) return [];
  try {
    return JSON.parse(fs.readFileSync(BLOG_JSON));
  } catch (e) {
    console.error("Error reading blogs.json:", e);
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

app.get("/health", (_, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

app.post("/blog/create", upload.single("cover"), (req, res) => {
  const { title, markdown, description, author, tags } = req.body;
  if (!title || !markdown) {
    return res.status(400).json({ error: "Title & markdown required" });
  }
  const coverPath = req.file
    ? `/images/blog/${req.file.filename}`
    : "/images/blog/default.jpg";

  const slug = slugify(title);
  const date = new Date().toISOString().split("T")[0];
  const htmlContent = marked.parse(markdown);

  const blogs = readBlogs();
  const blog = {
    title,
    slug,
    description: description || title,
    author: author || "Ontrack Team",
    date,
    url: `/blog/posts/${slug}.html`,
    cover: coverPath,
    tags: tags ? tags.split(",").map((t) => t.trim()) : [],
  };

  const tagsHtml = blog.tags.map((t) => `<span>${t}</span>`).join(" ");

  blogs.push(blog);
  fs.writeFileSync(BLOG_JSON, JSON.stringify(blogs, null, 2));

  let template = fs
    .readFileSync(TEMPLATE, "utf8")
    .replace(/{{title}}/g, blog.title)
    .replace(/{{description}}/g, blog.description)
    .replace(/{{date}}/g, blog.date)
    .replace(/{{author}}/g, blog.author)
    .replace(/{{cover}}/g, blog.cover)
    .replace(/{{content}}/g, htmlContent)
    .replace(/{{url}}/g, blog.url)
    .replace(/{{tags}}/g, tagsHtml);

  fs.writeFileSync(`${POSTS_DIR}/${slug}.html`, template);

  writeSitemap(blogs);

  const createdFiles = [`${POSTS_DIR}/${slug}.html`, BLOG_JSON, SITEMAP];

  if (req.file) {
    createdFiles.push(path.join(ROOT, "images/blog", req.file.filename));
  }

  gitAddCommitDeploy(createdFiles, title);
  res.json({ success: true, page: blog.url });
});

app.listen(3333, () =>
  console.log("📝 Blog generator running on http://localhost:3333"),
);
