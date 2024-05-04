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
          npmDepsHash = "sha256-3WVwp7Sc50oflyaGjwAM6T2L2rWrSpuTqXkWkYeQ2sw=";
        };
        packages.default = packages.kubo-simple-storage;
        packages.kubo-simple-storage-docker-image = pkgs.dockerTools.buildImage {
          name = "kubo-simple-storage";
          config = {
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
