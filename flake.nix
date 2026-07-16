{
  description = "MDForge — devShell pour l'extension VS Code (Node + vsce)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
          config.allowUnfree = true;
        };
      in
      {
        devShells.default = pkgs.mkShell {
          name = "mdforge";

          # Node bundle npm/npx. vsce sert au packaging (.vsix) — cf. script
          # `npm run package`. TypeScript / esbuild restent gérés par npm
          # (devDependencies), installés localement dans node_modules.
          buildInputs = with pkgs; [
            nodejs_22
            vsce
          ];

          shellHook = ''
            echo "📦 MDForge — Node $(node --version) / npm $(npm --version) / vsce $(vsce --version)"
            echo "   → npm install     (deps)"
            echo "   → npm run build   (compile ext + webview)"
            echo "   → npm run package (génère le .vsix)"
          '';
        };
      }
    );
}
