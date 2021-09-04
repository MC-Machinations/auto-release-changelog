<p align="center">
  <a href="https://github.com/actions/typescript-action/actions"><img alt="typescript-action status" src="https://github.com/actions/typescript-action/workflows/build-test/badge.svg"></a>
</p>

# auto-release-changelog

Based on [automatic-releases](https://github.com/marvinpinto/actions/blob/master/packages/automatic-releases) with further changelog customizations.

## arguments
```yaml
  token:
    required: true
    description: repository token
  draft:
    required: false
    description: Create a draft release
    default: 'false'
  pre-release:
    required: false
    description: Create a pre-release release
    default: 'false'
  title:
    required: false
    description: Title for release, defaults to the tag name
  files:
    required: false
    description: Files to include in the release
```
