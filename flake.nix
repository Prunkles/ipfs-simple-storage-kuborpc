{
  description = "IPFS Simple Storage (Kubo RPC)";

  inputs = {
    flake-parts.url = "github:hercules-ci/flake-parts";
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs = inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" "x86_64-darwin" ];
      perSystem = { pkgs, ... }: rec {
        packages.ipfs-simple-storage-kuborpc = pkgs.buildNpmPackage {
          pname = "ipfs-simple-storage-kuborpc";
          version = "0.0.1";
          src = ./.;
          npmDepsHash = "sha256-lBeyiHgoU88cMTQyZX3gqIml5cJlIFluff52LrMU/EM=";
        };
        packages.default = packages.ipfs-simple-storage-kuborpc;
        packages.ipfs-simple-storage-kuborpc-docker-image = pkgs.dockerTools.buildLayeredImage {
          name = "ipfs-simple-storage-kuborpc";
          contents = [
            pkgs.busybox
            pkgs.cacert
          ];
          config = {
            Env = [
              "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
            ];
            Cmd = [ "${packages.ipfs-simple-storage-kuborpc}/bin/ipfs-simple-storage-kuborpc" ];
          };
        };
        devShells = pkgs.mkShell {
          packages = [
            pkgs.node
          ];
        };
      };
      flake = { };
    };
}
