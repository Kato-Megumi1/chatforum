// Read only the user's paste event; never request background/system clipboard access.
export function clipboardFiles(data: DataTransfer | null, existingNames: string[] = []): File[] {
  if (!data) return [];
  const items = Array.from(data.items || []).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter((f): f is File => !!f);
  const source = items.length ? items : Array.from(data.files || []);
  const names = new Set(existingNames.map(name => name.toLowerCase()));
  return source.map(file => {
    const imageExtension = ({'image/png':'png','image/jpeg':'jpg','image/webp':'webp'} as Record<string,string>)[file.type];
    let name = file.name;
    // Screenshots from browsers are often all called image.png, or have no filename.
    if (imageExtension && (!name || /^(image|blob|clipboard)(\.(png|jpe?g|webp))?$/i.test(name)))
      name = `粘贴图片-${Date.now()}-${crypto.randomUUID().slice(0,8)}.${imageExtension}`;
    if (!name) name = '粘贴文件'; // Unsupported/unnamed non-images will receive normal format validation.
    const dot = name.lastIndexOf('.'), base = dot > 0 ? name.slice(0,dot) : name, ext = dot > 0 ? name.slice(dot) : '';
    let suffix = 2;
    while (names.has(name.toLowerCase())) name = `${base} (${suffix++})${ext}`;
    names.add(name.toLowerCase());
    return name === file.name ? file : new File([file], name, {type:file.type,lastModified:file.lastModified});
  });
}
