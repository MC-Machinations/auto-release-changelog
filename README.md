<p align="center">
    <a href="https://github.com/MC-Machinations/auto-release-changelog/blob/main/LICENSE"><img alt="GitHub license" src="https://img.shields.io/github/license/MC-Machinations/auto-release-changelog"></a>
</p>

# auto-release-changelog

Based on [automatic-releases](https://github.com/marvinpinto/actions/blob/master/packages/automatic-releases) with further changelog customizations.  
Requires use of [semantic versioning](https://semver.org/) on tags

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
  skip-prereleases:
    required: false
    description: If enabled, when a new non-prerelease tag is pushed, the changelog will be created between the pushed tag, and the last non-prerelease tag
```
