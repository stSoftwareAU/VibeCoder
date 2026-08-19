#!/usr/bin/env ruby
# Build-time script: replace <a> links to non-published paths with a non-clickable span
# so users don't get 404s. The span has a tooltip and subtle styling to show the link was redacted.
# Does not modify source .md files.

# Paths that are not published on GH Pages (from _config.yml exclude + scripts)
UNPUBLISHED_PATTERNS = [
  /\.sh\b/i,           # any .sh file
  %r{worker/},          # worker/run_core.sh, worker/shared/...
  %r{setup/},
  %r{tests/},
  %r{prompts/},
  %r{hooks/},
  %r{\.github/},
  %r{\.config\.json},
  %r{/Gemfile(\?|$)},
  /\bquality\.sh\b/,
  /\brun\.sh\b/,
  %r{worker/deno/},     # deno source (not published)
].freeze

def unpublished?(href)
  return false if href.nil? || href.empty?
  return false if href.start_with?('#', 'http://', 'https://', 'mailto:')
  # Strip anchor for check
  path = href.split('#').first.to_s.strip
  return false if path.empty?
  # Normalise relative: remove leading ./ and all leading ../
  path = path.gsub(%r{^\./}, '').gsub(%r{^(\.\./)+}, '')
  UNPUBLISHED_PATTERNS.any? { |re| path.match?(re) }
end

REDACTED_TITLE = 'Source file — not published on this site'.freeze

def strip_bad_links(html)
  # Match <a ... href="..." ...>content</a> (content may contain nested tags)
  html.gsub(%r{<a\s+[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)</a>}mi) do
    href = Regexp.last_match(1)
    inner = Regexp.last_match(2)
    if unpublished?(href)
      %(<span class="redacted-source-link" title="#{REDACTED_TITLE}">#{inner}</span>)
    else
      Regexp.last_match(0)
    end
  end
end

root = File.join(__dir__, '../..')
site_dir = File.join(root, '_site')
Dir.glob(File.join(site_dir, '**', '*.{html,md}')) do |path|
  next unless File.file?(path)

  content = File.read(path)
  new_content = strip_bad_links(content)
  File.write(path, new_content) if new_content != content
end
