#!/usr/bin/env ruby
# Build-time script: wrap every PR summary body in
# `{% raw %} ... {% endraw %}` so any Liquid-looking syntax in PR summary
# prose is rendered literally instead of being interpreted by Jekyll.
# Issue #1575. Issue #2173 made docs/archive/pr-summaries/ the canonical
# home; the loose docs/ location is retained for any older PRs that have
# not been moved yet.
#
# Behaviour:
#   - Idempotent: files that already start with `{% raw %}` (after any
#     front-matter) are left unchanged.
#   - Front-matter preserved: a leading `---\n...---\n` block stays
#     outside the raw wrap, so layout/title metadata still applies.
#   - Body wrapped on its own lines so kramdown still parses block-level
#     markdown structure inside the raw region.
#
# Called from .github/scripts/inject_page_metadata.rb (which runs before
# `jekyll build` in .github/workflows/pages.yml), so the workflow YAML
# stays unchanged — important because the worker cannot push workflow
# files.

# Split a file into [front_matter_with_trailing_newline, body].
# If no front-matter is present the first element is empty string.
def split_front_matter(content)
  m = content.match(/\A---\s*\n.*?\n---\s*\n/m)
  return ['', content] unless m

  [content[0...m.end(0)], content[m.end(0)..-1] || '']
end

# True if the body (post-front-matter) already contains any `{% raw %}`
# or `{% endraw %}` marker. Liquid does not support nested raw blocks
# (the first `{% endraw %}` closes the outer one), so any pre-existing
# inline raw markers — for example the hand-applied ones from #1574 —
# mean we must leave the file alone. Older content that was manually
# escaped continues to render correctly; only fresh PR summaries with
# no raw markers are wrapped.
def already_wrapped?(body)
  body.include?('{% raw %}') || body.include?('{% endraw %}')
end

# Wrap `body` in {% raw %} ... {% endraw %} on their own lines, ensuring
# exactly one blank-free newline either side of the markers so kramdown
# block parsing is unaffected.
def wrap_body(body)
  trimmed = body.sub(/\A\n+/, '').sub(/\n+\z/, '')
  "{% raw %}\n#{trimmed}\n{% endraw %}\n"
end

def wrap_file(path)
  content = File.read(path)
  front, body = split_front_matter(content)
  return if already_wrapped?(body)

  wrapped = wrap_body(body)
  File.write(path, front + wrapped)
end

# When required (not run directly), expose the helpers but do not
# walk the filesystem.
if $PROGRAM_NAME == __FILE__
  root = File.join(__dir__, '../..')
  Dir.chdir(root) do
    paths = Dir['docs/pr-summary-*.md'] +
            Dir['docs/archive/pr-summaries/pr-summary-*.md']
    paths.sort.each do |path|
      wrap_file(path) if File.file?(path)
    end
  end
end
