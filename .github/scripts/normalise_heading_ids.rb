#!/usr/bin/env ruby
# Build-time script: strip leading hyphen from heading id attributes in _site HTML.
# Kramdown generates id="-threat-model" for headings that start with an emoji; TOC links use #threat-model.
# Normalising IDs so fragment navigation works. Does not modify source .md files.

site_dir = File.join(__dir__, '../..', '_site')
Dir.glob(File.join(site_dir, '**', '*.{html,md}')) do |path|
  next unless File.file?(path)

  content = File.read(path)
  # id="-foo" or id='-foo' -> id="foo" / id='foo' so #foo in URL matches
  new_content = content.gsub(%r{(\sid=)(["'])-([^"']+)\2}, '\1\2\3\2')
  File.write(path, new_content) if new_content != content
end
