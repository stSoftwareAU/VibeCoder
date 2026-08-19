#!/usr/bin/env ruby
# Build-time script: inject layout, title, and optional page_icon into docs and root .md files
# so GitHub Pages shows per-page titles (and icon in browser tab). Reads _data/page_titles.yml.
# Called from .github/workflows/pages.yml. Does not modify the repo on disk outside the runner.

require 'yaml'

# Force UTF-8 I/O regardless of the host locale (Issue #3590). When
# Encoding.default_external is US-ASCII (LANG/LC_ALL unset or set to C),
# File.read/File.write mangle non-ASCII bytes and String#inspect escapes
# them as \u{...}, so a page_icon emoji lands in the front matter as
# `page_icon: "\u{1F680}"` instead of the literal character.
Encoding.default_external = Encoding::UTF_8
Encoding.default_internal = Encoding::UTF_8

data_path = File.join(__dir__, '../../_data/page_titles.yml')
# Issue #3661 (SEC-73515a44685a): safe_load_file, not load_file. `_data/page_titles.yml`
# is PR-editable, and on Psych 3 `load_file` deserialises arbitrary Ruby objects — the
# Pages job is only safe today because the workflow happens to pin Ruby 3.1 (Psych 4).
# Make the safety explicit so a Ruby downgrade or a `psych ~> 3` gem cannot turn a docs
# PR into RCE in the build job. The file is a plain string mapping, so the default
# permitted-class set is sufficient; a payload now raises instead of executing.
# `safe_load(File.read(...))` rather than `safe_load_file` — the former exists on
# Psych 3 too, so the guarantee does not itself depend on the Ruby version.
metadata = File.exist?(data_path) ? (YAML.safe_load(File.read(data_path)) || {}) : {}

def derive_title(path)
  base = File.basename(path, '.md')
  base.gsub(/-/, ' ').split.map(&:capitalize).join(' ')
end

# Build the front-matter header as a string (no trailing newline).
def build_front_matter(title, page_icon)
  lines = ['---', 'layout: default', "title: #{title.inspect}"]
  lines << "page_icon: #{page_icon.inspect}" if page_icon && !page_icon.empty?
  lines << '---'
  lines.join("\n")
end

# Inject front-matter into a file that does not yet have any.
def inject_front_matter(file_path, title, page_icon)
  content = File.read(file_path)
  return if content.start_with?('---')

  File.write(file_path, build_front_matter(title, page_icon) + "\n\n" + content)
end

# Replace an existing (possibly minimal) front-matter block with full metadata.
# Used for index.md, which the pages workflow pre-seeds with `---\nlayout: default\n---`
# before this script runs. Falls back to injection if no front-matter is present.
def rewrite_front_matter(file_path, title, page_icon)
  content = File.read(file_path)
  header = build_front_matter(title, page_icon)

  if (m = content.match(/\A---\s*\n.*?\n---\s*(?:\n|\z)/m))
    body = content[m.end(0)..-1] || ''
    body = body.sub(/\A\n+/, '')
    File.write(file_path, header + "\n\n" + body)
  else
    File.write(file_path, header + "\n\n" + content)
  end
end

PREFIX = 'Vibe Coder: '

def prefixed_title(meta, path)
  base = (meta && meta['title']) || derive_title(path)
  base.start_with?(PREFIX) ? base : "#{PREFIX}#{base}"
end

root = File.join(__dir__, '../..')
Dir.chdir(root) do
  paths = Dir['docs/**/*.md'].to_a + %w[README.md SECURITY.md AGENTS.md]
  paths.each do |path|
    next unless File.file?(path)

    meta = metadata[path] || {}
    inject_front_matter(path, prefixed_title(meta, path), meta['page_icon'])
  end

  # index.md is created by the pages workflow from README.md with a bare
  # `---\nlayout: default\n---` wrapper. Rewrite that front-matter using
  # README.md's entry so the homepage gets the same title and favicon.
  if File.file?('index.md')
    readme_meta = metadata['README.md'] || {}
    rewrite_front_matter(
      'index.md',
      prefixed_title(readme_meta, 'README.md'),
      readme_meta['page_icon'],
    )
  end

  # Wrap every published Markdown body in {% raw %} ... {% endraw %} so
  # Liquid-looking syntax in prose is rendered literally. Originally
  # introduced for PR summaries (#1575); extended to AGENTS.md, README.md,
  # SECURITY.md, and docs/**/*.md by #1600 after the AGENTS.md "Liquid
  # syntax" example section broke the Pages build with an unmatched
  # {% if %} tag.
  #
  # The wrap is idempotent and skipped for files that already contain
  # inline {% raw %} markers (Liquid does not support nested raw blocks).
  # Called here rather than from the workflow so the workflow YAML stays
  # unchanged — the worker cannot push workflow files.
  wrap_script = File.join(__dir__, 'wrap_pr_summary_raw.rb')
  load wrap_script if File.file?(wrap_script)
  if defined?(wrap_file)
    wrap_paths = Dir['docs/**/*.md'] +
                 %w[AGENTS.md README.md SECURITY.md index.md]
    wrap_paths.uniq.sort.each do |path|
      wrap_file(path) if File.file?(path)
    end
  end
end
