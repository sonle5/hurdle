export function slugify(title) {
  return title.trim().toLowerCase().replace(" ", "-");
}
