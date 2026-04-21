class Ryoko < Formula
  desc "OpenRyoko — Slackで空気を読んで働くAIゲートウェイ（Jinnベース）"
  homepage "https://github.com/rsensui2/OpenRyoko"
  url "https://registry.npmjs.org/openryoko/-/openryoko-0.9.4-ryoko.1.tgz"
  sha256 "TBD_REPLACE_ON_FIRST_PUBLISH"
  license "MIT"

  livecheck do
    url "https://registry.npmjs.org/openryoko"
    regex(/"latest":\s*"(\d+(?:\.\d+)+(?:-[A-Za-z0-9.]+)?)"/)
  end

  depends_on "node@22"
  depends_on "python" => :build

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  def caveats
    <<~EOS
      はじめに、以下を実行してください:
        ryoko setup

      ゲートウェイデーモンを起動:
        ryoko start

      Webダッシュボードは http://localhost:7777 で利用可能です。
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/ryoko --version")
    assert_match "Usage", shell_output("#{bin}/ryoko --help")

    cd libexec/"lib/node_modules/openryoko" do
      system "node", "-e", "require('better-sqlite3')"
      system "node", "-e", "require('classic-level')"
    end
  end
end
