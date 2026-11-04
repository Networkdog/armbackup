import catalog from "./resource-support.json" with { type: "json" };

export const SUPPORTED_RESOURCES = catalog.resources;
export const officialPolicyTypes = (types) => types.map((type) => type.toLowerCase())
  .filter((type) => SUPPORTED_RESOURCES.some((entry) => entry.type === type));
export const legacyPolicyTypes = (types) => types.filter((type) =>
  !SUPPORTED_RESOURCES.some((entry) => entry.type === type.toLowerCase()));

export function relatedPolicyResources(resources, current, roots) {
  const selected = new Set(roots.map((resource) => resource.id.toLowerCase()));
  const byId = new Map(resources.map((resource) => [resource.id.toLowerCase(), resource]));
  function references(value) {
    if (Array.isArray(value)) return value.flatMap(references);
    if (!value || typeof value !== "object") return [];
    return Object.entries(value).flatMap(([name, child]) =>
      name.toLowerCase() === "id" && typeof child === "string" ? [child.toLowerCase()] : references(child));
  }
  for (const root of roots) {
    const profile = SUPPORTED_RESOURCES.find((entry) => entry.type === root.type.toLowerCase());
    if (!profile) continue;
    for (const identifier of references(current[root.id.toLowerCase()]?.raw)) {
      const related = byId.get(identifier);
      if (related && profile.relatedTypes.includes(related.type.toLowerCase())) selected.add(identifier);
    }
    for (const resource of resources) {
      if (resource.id.toLowerCase().startsWith(root.id.toLowerCase() + "/")
          && profile.containedTypes.includes(resource.type.toLowerCase())) selected.add(resource.id.toLowerCase());
    }
  }
  return resources.filter((resource) => selected.has(resource.id.toLowerCase()));
}
