// Renders the portfolio from /data/profile.json — the same file Jarvis answers from.
(function () {
  "use strict";

  function el(tag, attrs, text) {
    const node = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text != null) node.textContent = text;
    return node;
  }

  function render(p) {
    document.title = p.name ? `${p.name} — ${p.role || "Portfolio"}` : "Portfolio";
    document.querySelectorAll("[data-field]").forEach((node) => {
      const value = p[node.dataset.field];
      if (value) node.textContent = value;
    });

    const skills = document.getElementById("skills-list");
    skills.replaceChildren(...(p.skills || []).map((s) => el("li", null, s)));

    const stack = document.getElementById("hero-stack");
    if (stack) stack.replaceChildren(...(p.skills || []).slice(2, 7).map((s) => el("li", null, s)));

    // The big hero name is split into first name and the rest (two layered lines).
    if (p.name) {
      const [first, ...rest] = p.name.trim().split(/\s+/);
      document.querySelectorAll('[data-name-part="first"]').forEach((n) => (n.textContent = first));
      document.querySelectorAll('[data-name-part="last"]').forEach((n) => (n.textContent = rest.join(" ")));
      const photo = document.querySelector(".hero-figure");
      if (photo) photo.alt = `Portrait of ${p.name}`;
    }

    const projects = document.getElementById("project-list");
    projects.replaceChildren(
      ...(p.projects || []).map((proj) => {
        const card = el("article", { class: "project-card" });
        card.append(el("h3", null, proj.name), el("p", null, proj.description));
        if (proj.highlights?.length) {
          const list = el("ul", { class: "highlights" });
          proj.highlights.forEach((h) => list.append(el("li", null, h)));
          card.append(list);
        }
        if (proj.tech?.length) {
          const tech = el("ul", { class: "tech", "aria-label": "Technologies" });
          proj.tech.forEach((t) => tech.append(el("li", null, t)));
          card.append(tech);
        }
        if (proj.url) {
          card.append(el("a", { class: "card-link", href: proj.url, target: "_blank", rel: "noopener" }, "View on GitHub →"));
        }
        return card;
      })
    );

    const contact = document.getElementById("contact-links");
    const links = [...(p.links || [])];
    if (p.email) links.unshift({ label: p.email, url: `mailto:${p.email}` });
    contact.replaceChildren(
      ...links.map((l) => {
        const li = el("li");
        li.append(el("a", { href: l.url, target: l.url.startsWith("mailto:") ? "_self" : "_blank", rel: "noopener" }, l.label));
        return li;
      })
    );
  }

  document.getElementById("year").textContent = new Date().getFullYear();
  fetch("/data/profile.json")
    .then((r) => {
      if (!r.ok) throw new Error(`profile ${r.status}`);
      return r.json();
    })
    .then(render)
    .catch((err) => console.error("[portfolio] could not load profile", err));
})();
