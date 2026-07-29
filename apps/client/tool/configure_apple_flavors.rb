#!/usr/bin/env ruby

require "digest"
require "fileutils"

FLAVORS = %w[dev prod].freeze

def deterministic_id(seed)
  Digest::SHA1.hexdigest(seed)[0, 24].upcase
end

def configuration_object(project, id)
  pattern = /^\t\t#{id} \/\* ([^*]+) \*\/ = \{\n.*?^\t\t\};$/m
  project.match(pattern)&.[](0) ||
    raise("Could not find build configuration #{id}")
end

def add_setting(object, key, value)
  line_pattern = /^(\t\t\t\t)#{Regexp.escape(key)} = .*;$/
  if object.match?(line_pattern)
    object.sub(line_pattern, "\\1#{key} = #{value};")
  else
    object.sub(
      /^(\t\t\tbuildSettings = \{\n)/,
      "\\1\t\t\t\t#{key} = #{value};\n",
    )
  end
end

def configure_project(path:, platform:, lists:)
  project = File.read(path)
  return if project.include?("Debug-dev") && project.include?("Debug-prod")

  additions = []

  lists.each do |list_id, kind|
    list_pattern =
      /^(\t\t#{list_id} \/\* Build configuration list .*?buildConfigurations = \(\n)(.*?)(^\t\t\t\);.*?^\t\t\};$)/m
    list_match = project.match(list_pattern) ||
      raise("Could not find configuration list #{list_id}")
    entries = list_match[2].scan(
      /^\t\t\t\t([A-F0-9]{24}) \/\* (Debug|Profile|Release) \*\/,$/,
    )
    raise("No base configurations in #{list_id}") if entries.empty?

    new_entries = +""
    entries.each do |base_id, mode|
      source = configuration_object(project, base_id)

      FLAVORS.each do |flavor|
        name = "#{mode}-#{flavor}"
        new_id = deterministic_id("#{platform}:#{list_id}:#{name}")
        copy = source
          .sub(base_id, new_id)
          .sub("/* #{mode} */", "/* #{name} */")
          .sub(/\t\t\tname = #{mode};/, "\t\t\tname = #{name};")

        if kind == :runner
          bundle_id = flavor == "dev" ?
            "org.ovrseer.app.dev" :
            "org.ovrseer.app"
          display_name = flavor == "dev" ? '"Overseer Dev"' : "Overseer"
          copy = add_setting(copy, "PRODUCT_BUNDLE_IDENTIFIER", bundle_id)
          copy = add_setting(copy, "APP_DISPLAY_NAME", display_name)
          callback_scheme = flavor == "dev" ? "overseer-dev" : "overseer"
          copy = add_setting(copy, "OAUTH_CALLBACK_SCHEME", callback_scheme)
          if platform == :macos
            product_name = flavor == "dev" ? '"Overseer Dev"' : "Overseer"
            copy = add_setting(copy, "PRODUCT_NAME", product_name)
            if flavor == "dev"
              copy = add_setting(copy, "CODE_SIGNING_ALLOWED", "NO")
              copy = add_setting(copy, "CODE_SIGN_IDENTITY", '"-"')
              copy = add_setting(copy, "CODE_SIGN_STYLE", "Manual")
              copy = add_setting(copy, "DEVELOPMENT_TEAM", '""')
            end
          end
        elsif kind == :tests
          test_bundle_id = flavor == "dev" ?
            "org.ovrseer.app.dev.RunnerTests" :
            "org.ovrseer.app.RunnerTests"
          copy = add_setting(copy, "PRODUCT_BUNDLE_IDENTIFIER", test_bundle_id)
          if platform == :macos
            host_name = flavor == "dev" ? "Overseer Dev" : "Overseer"
            copy = copy.gsub(
              %r{TEST_HOST = .*?\.app/\$\(BUNDLE_EXECUTABLE_FOLDER_PATH\)/.*?;},
              "TEST_HOST = \"$(BUILT_PRODUCTS_DIR)/#{host_name}.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/#{host_name}\";",
            )
          end
        end

        additions << copy
        new_entries << "\t\t\t\t#{new_id} /* #{name} */,\n"
      end
    end

    replacement = list_match[1] + list_match[2] + new_entries + list_match[3]
    project.sub!(list_match[0], replacement)
  end

  marker = "/* End XCBuildConfiguration section */"
  project.sub!(marker, additions.join("\n") + "\n" + marker)
  File.write(path, project)
end

def create_schemes(directory:, platform:)
  source = File.read(File.join(directory, "Runner.xcscheme"))

  FLAVORS.each do |flavor|
    scheme = source
      .gsub('buildConfiguration = "Debug"', "buildConfiguration = \"Debug-#{flavor}\"")
      .gsub('buildConfiguration = "Profile"', "buildConfiguration = \"Profile-#{flavor}\"")
      .gsub('buildConfiguration = "Release"', "buildConfiguration = \"Release-#{flavor}\"")
    if platform == :macos
      product = flavor == "dev" ? "Overseer Dev.app" : "Overseer.app"
      scheme = scheme.gsub('BuildableName = "overseer_mobile.app"', "BuildableName = \"#{product}\"")
    end
    File.write(File.join(directory, "#{flavor}.xcscheme"), scheme)
  end
end

root = File.expand_path("..", __dir__)

configure_project(
  path: File.join(root, "ios/Runner.xcodeproj/project.pbxproj"),
  platform: :ios,
  lists: {
    "331C8087294A63A400263BE5" => :tests,
    "97C146E91CF9000F007C117D" => :project,
    "97C147051CF9000F007C117D" => :runner,
  },
)
create_schemes(
  directory: File.join(root, "ios/Runner.xcodeproj/xcshareddata/xcschemes"),
  platform: :ios,
)

configure_project(
  path: File.join(root, "macos/Runner.xcodeproj/project.pbxproj"),
  platform: :macos,
  lists: {
    "331C80DE294CF71000263BE5" => :tests,
    "33CC10E82044A3C60003C045" => :project,
    "33CC10FB2044A3C60003C045" => :runner,
    "33CC111B2044C6BA0003C045" => :aggregate,
  },
)
create_schemes(
  directory: File.join(root, "macos/Runner.xcodeproj/xcshareddata/xcschemes"),
  platform: :macos,
)
