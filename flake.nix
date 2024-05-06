{
  description = "Kubo Simple Storage";

  inputs = {
    flake-parts.url = "github:hercules-ci/flake-parts";
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs = inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" "x86_64-darwin" ];
      perSystem = { pkgs, ... }: rec {
        packages.kubo-simple-storage = pkgs.buildNpmPackage {
          pname = "kubo-simple-storage";
          version = "0.0.1";
          src = ./.;
          npmDepsHash = "sha256-w3LcQsEjoTOsbV41mjG9NJlafjbdNkhB/obA9iyA5to=";
        };
        packages.default = packages.kubo-simple-storage;
        packages.kubo-simple-storage-docker-image = pkgs.dockerTools.buildLayeredImage {
          name = "kubo-simple-storage";
          contents = [
            pkgs.busybox
            pkgs.cacert
          ];
          config = {
            Env = [
              "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
            ];
            Cmd = [ "${packages.kubo-simple-storage}/bin/kubo-simple-storage" ];
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
