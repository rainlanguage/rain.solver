{
  inputs = {
    flake-utils.url = "github:numtide/flake-utils";
    rainix.url = "github:rainprotocol/rainix";
  };

  outputs =
    {
      self,
      flake-utils,
      rainix,
    }:

    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = rainix.pkgs.${system};
      in
      rec {
        # For `nix develop`:
        devShells.default = pkgs.mkShell {
          nativeBuildInputs = [
            rainix.node-build-inputs.${system}
            rainix.sol-build-inputs.${system}
            pkgs.doctl
          ];
          shellHook = ''
            # download chains config json from chainlist
            curl -sS -o ./chains.json "https://chainlist.org/rpcs.json"
          '';
        };
      }
    );
}
