/* globals fetch, location, $, sendBlockRequest, changeButtonToBlocked */

// some code taken from:
// https://github.com/satsukitv/twitter-block-chain
{
  const CHAINBLOCK_UI_HTML = `
    <div class="mobcb-bg modal-container block-dialog">
      <div class="mobcb-dialog modal modal-content is-autoPosition">
        <div class="mobcb-title">체인맞블락</div>
        <hr class="mobcb-hr">
        <span class="mobcb-progress"></span>
        <hr class="mobcb-hr">
        <div class="mobcb-users">
          <ul class="mobcb-target-users"></ul>
          <ul class="mobcb-skipped-users"></ul>
        </div>
        <div class="mobcb-controls">
          <div class="mobcb-bottom-message"></div>
          <button class="mobcb-close btn">닫기</button>
          <button disabled class="mobcb-execute btn caution-btn" title="위 사용자를 실제로 차단합니다.">차단</button>
          <button class="mobcb-toggle-blur btn" title="캡처시 사용자를 가리고 싶을 때 사용해주세요.">가리기</button>
        </div>
      </div>
    </div>
  `
  const CHAINBLOCK_UI_CSS = `
    .mobcb-bg {
      position: fixed;
      display: flex;
      justify-content: center;
      align-items: center;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 9999;
      overflow: hidden;
      background-color: rgba(0, 0, 0, .6);
    }
    hr.mobcb-hr {
      margin: 3px 0;
    }
    .mobcb-dialog {
      padding: 15px;
      display: flex;
      flex-direction: column;
      width: 450px;
      max-height: 80vh;
    }
    .mobcb-title {
      font-size: 16px;
      font-weight: bold;
      margin-bottom: 5px;
    }
    .mobcb-users {
      min-width: 60px;
      overflow-y: scroll;
    }
    .mobcb-users > ul {
      list-style: none;
      line-height: 150%;
    }
    .mobcb-dialog.mobcb-blur .mobcb-user {
      filter: blur(5px) saturate(0%);
    }
    .mobcb-controls {
      margin-top: 5px;
    }
    .mobcb-bottom-message {
      float: left;
      padding: 10px 0;
    }
    .mobcb-controls .btn {
      margin-left: 5px;
    }
  `
  function restoreConsole () {
    if (/\[native code]/.test(window.console.log.toString())) {
      return
    }
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    window.console = new Proxy(iframe.contentWindow.console, {
      set () {
        return true
      }
    })
  }

  function sleep (time) {
    return new Promise(resolve => {
      window.setTimeout(() => {
        resolve()
      }, time)
    })
  }

  class EventEmitter {
    constructor () {
      this.events = {}
    }
    on (eventname, handler) {
      if (!(eventname in this.events)) {
        this.events[eventname] = []
      }
      this.events[eventname].push(handler)
      return this
    }
    emit (eventname, eparameter) {
      const handlers = this.events[eventname] || []
      handlers.forEach(handler => handler(eparameter))
      return this
    }
  }

  class FollwerGatherer extends EventEmitter {
    constructor (options) {
      super()
      this.options = Object.assign({}, {
        // default options
        delay: 500,
        delayOnLimitation: 1000 * 60 * 2,
        stopOnLimit: true,
        filter: () => true
      }, options)
      this.stopped = false
    }
    static _parseUserProfileCard (card_) {
      const $card = $(card_)
      const blocksYou = $card.find('.blocks-you').length > 0
      const actions = $($card.find('.user-actions'))
      const userId = String(actions.data('user-id'))
      const userName = actions.data('screen-name')
      const userNickName = $card.find('.fullname').text().trim()
      const alreadyBlocked = $card.find('.blocked').length > 0
      const muted = $card.find('.muting').length > 0
      const bio = $card.find('.ProfileCard-bio').text().trim()
      return {
        userId,
        userName,
        userNickName,
        blocksYou,
        alreadyBlocked,
        muted,
        bio
      }
    }
    stop () {
      this.stopped = true
    }
    async start (username, followtype) {
      const {
        delay,
        delayOnLimitation,
        filter,
        stopOnLimit
      } = this.options
      this.stopped = false
      if (followtype !== 'followers' && followtype !== 'following') {
        throw new Error(`followtype ${followtype} is invalid!`)
      }
      let gatheredCount = 0
      let nextPosition = null
      while (true) {
        if (this.stopped) {
          this.emit('end', {
            userStopped: true
          })
          break
        }
        const maxPosition = nextPosition ? `&max_position=${nextPosition}` : ''
        const url = `https://twitter.com/${username}/${followtype}/users?
        include_available_features=1&
        include_entities=1&
        reset_error_state=true
        ${maxPosition}`.replace(/\s+/g, '')
        let response
        while (true) {
          response = await fetch(url, {
            method: 'GET',
            credentials: 'include',
            referrer: location.href
          })
          if (response.ok) {
            break
          }
          if (response.status === 429) {
            this.emit('limit')
            console.info('FollowerGather: limited!')
            if (stopOnLimit) {
              throw new Error('LimitError!')
            } else {
              await sleep(delayOnLimitation)
            }
          } else {
            this.emit('error', response)
            throw new Error('HTTPError!')
          }
        }
        const json = await response.json()
        const templ = document.createElement('template')
        templ.innerHTML = json.items_html
        const node = templ.content.cloneNode(true)
        const cards = node.querySelectorAll('.ProfileCard')
        gatheredCount += cards.length
        let users = Array.from(cards || [], FollwerGatherer._parseUserProfileCard)
        if (typeof filter === 'function') {
          users = users.filter(filter)
        }
        this.emit('progress', {
          users,
          gatheredCount
        })
        if (json.has_more_items) {
          nextPosition = json.min_position
          await sleep(delay)
        } else {
          this.emit('end', {
            userStopped: false
          })
          break
        }
      }
    }
  }

  class ChainBlockUI {
    constructor (options) {
      this.targets = []
      this.skipped = []
      this.followersCount = 0
      this.originalTitle = document.title
      $('<div>').html(`&shy;<style>${CHAINBLOCK_UI_CSS}</style>`).appendTo(document.body)
      const progressUI = this.progressUI = $('<div>')
      progressUI.html(CHAINBLOCK_UI_HTML)
      progressUI.appendTo(document.body)
      if (options.chainBlockOver10KMode) {
        const dialogTitle = progressUI.find('.mobcb-title')
        dialogTitle.text(
          dialogTitle.text() + ' (슬로우 모드)'
        )
      }
      progressUI.on('click', '.mobcb-toggle-blur', event => {
        event.preventDefault()
        progressUI.find('.mobcb-dialog').toggleClass('mobcb-blur')
      })
      progressUI.on('click', '.mobcb-close', event => {
        event.preventDefault()
        this.close()
      })
    }
    update ({ users, gatheredCount }) {
      for (const user of users) {
        if (user.alreadyBlocked) {
          user.shouldSkip = true
          this.skipped.push(user)
        } else if (user.muted) {
          user.shouldSkip = true
          this.skipped.push(user)
        } else {
          user.shouldSkip = false
          this.targets.push(user)
        }
      }
      this.updateUI({ users, gatheredCount })
    }
    updateUI ({ users, gatheredCount }) {
      const { targets,
        skipped,
        originalTitle,
        followersCount,
        progressUI: ui
      } = this
      const count = targets.length + skipped.length
      const percentage = Math.round(count / followersCount * 100)
      document.title = `(${percentage}% | ${targets.length}명) 체인맞블락 사용자 수집중\u2026 \u2013 ${originalTitle}`
      for (const user of users) {
        const {
          userId,
          userName,
          userNickName,
          alreadyBlocked,
          muted,
          shouldSkip
        } = user
        let userPrefix = ''
        if (alreadyBlocked) {
          userPrefix = '[Blocked] '
        } else if (muted) {
          userPrefix = '[Skip] '
        }
        const item = $('<li>')
          .addClass('mobcb-user')
        const link = $('<a>')
          .attr('data-user-id', userId)
          .attr('href', `https://twitter.com/${userName}`)
          .attr('target', '_blank')
          .attr('title', `@${userName} (${userNickName})
프로필: ${user.bio}`)
          .text(`${userPrefix} @${userName}: ${userNickName}`)
        item.append(link)
        if (shouldSkip) {
          ui.find('.mobcb-skipped-users').append(item)
        } else {
          ui.find('.mobcb-target-users').append(item)
        }
      }
      ui.find('.mobcb-progress').text(
        `체인맞블락 중간 보고: ${gatheredCount}명 중 타겟 ${targets.length}명, 스킵 ${skipped.length}명`
      )
    }
    finalize () {
      const {
        targets,
        skipped,
        originalTitle,
        followersCount,
        progressUI: ui
      } = this
      document.title = `체인맞블락 수집완료! \u2013 ${originalTitle}`
      ui.find('.mobcb-progress').text(
        `체인맞블락 결과 보고: ${followersCount}명 중 타겟 ${targets.length}명, 스킵 ${skipped.length}명`
      )
      ui.find('.mobcb-bottom-message').text(`${targets.length}명 맞차단 가능`)
      if (targets.length === 0 && skipped.length === 0) {
        window.alert('여기에선 아무도 나를 차단하지 않았습니다.')
        this.close()
        return
      } else if (targets.length > 0) {
        ui.find('.mobcb-controls .btn').prop('disabled', false)
      }
      ui.find('.mobcb-execute').click(event => {
        event.preventDefault()
        if (targets.length === 0) {
          window.alert('맞차단할 사용자가 없습니다.')
          return
        }
        if (window.confirm('실제로 맞차단하시겠습니까?')) {
          document.title = `체인맞블락 차단중\u2026 \u2013 ${originalTitle}`
          const promises = targets.map(user => {
            const {userId} = user
            return sendBlockRequest(userId)
              .then(() => ' \u2714', () => ' \u274C')
              .then(result => {
                const text = document.createTextNode(result)
                ui.find(`.mobcb-target-users a[data-user-id="${userId}"]`).prepend(text)
                return {
                  user,
                  ok: result === ' \u2714'
                }
              })
          })
          Promise.all(promises).then(results => {
            const successes = results.filter(x => x.ok)
            ui.find('.mobcb-execute').prop('disabled', true)
            ui.find('.mobcb-bottom-message').text(`${successes.length}명 맞차단 완료!`)
            document.title = `체인맞블락 차단완료! \u2013 ${originalTitle}`
            for (const result of successes) {
              const {userId} = result.user
              const profileCard = $(`.ProfileCard[data-user-id="${userId}"]`)
              profileCard.each((_, card) => changeButtonToBlocked(card))
            }
            targets.length = 0
          })
        }
      })
      console.dir({ targets, skipped })
    }
    close () {
      document.title = this.originalTitle
      this.progressUI.remove()
      // TODO: prevent use-after-close?
    }
  }

  function isChainBlockablePage () {
    try {
      if (location.hostname !== 'twitter.com') {
        return false
      }
      return /^\/@?[\w\d_]+\/(?:followers|following)$/.test(location.pathname)
    } catch (e) {
      return false
    }
  }

  function checkSelfChainBlock () {
    const currentUserId = String($('.ProfileNav').data('user-id'))
    const myUserId = String($('#current-user-id').val())
    const valid = /\d+/.test(currentUserId) && /\d+/.test(myUserId)
    return valid && (currentUserId === myUserId)
  }

  function alreadyRunning () {
    return $('.mobcb-bg').length > 0
  }

  function blockedUser () {
    return $('.BlocksYouTimeline').length > 0
  }

  restoreConsole()
  if (!isChainBlockablePage()) {
    window.alert('PC용 트위터(twitter.com)의 팔로잉 혹은 팔로워 페이지에서만 작동합니다.')
  } else if (checkSelfChainBlock()) {
    window.alert('자기 자신에게 체인맞블락을 할 순 없습니다.')
  } else if (alreadyRunning()) {
    window.alert('현재 체인맞블락이 가동중입니다. 잠시만 기다려주세요.')
  } else if (blockedUser()) {
    window.alert('이미 나를 차단한 사용자의 팔로잉/팔로워가 누군지 알 수 없습니다.')
  } else if (window.confirm('체인맞블락을 위해 나를 차단한 사용자를 찾습니다. 계속하시겠습니까?')) {
    let options = {}
    try {
      const optionsJSON = window.sessionStorage.getItem('$MirrorOfBlockOptions')
      options = JSON.parse(optionsJSON || '{}')
      Object.freeze(options)
    } catch (error) {
      console.error('fail to retrieve option: ', error)
    }
    const currentList = (path => {
      if (/\/followers$/.test(path)) {
        return 'followers'
      } else if (/\/following$/.test(path)) {
        return 'following'
      } else {
        throw new Error('unsupported page')
      }
    })(location.pathname)
    const ui = new ChainBlockUI(options)
    ui.followersCount = Number($(`.ProfileNav-item--${currentList} [data-count]`).eq(0).data('count'))
    const gatherer = new FollwerGatherer({
      filter: user => user.blocksYou,
      delay: options.chainBlockOver10KMode ? 2500 : 250
    })
    ui.progressUI.on('click', '.mobcb-close', () => {
      gatherer.stop()
    })
    gatherer.on('progress', ({ users, gatheredCount }) => {
      console.log('progress', users)
      ui.update({ users, gatheredCount })
    })
    gatherer.on('limit', () => {
      window.alert('더 이상 사용자 목록을 가져올 수 없습니다. 체인맞블락을 중단합니다.')
      gatherer.stop()
    })
    gatherer.on('error', () => {
      window.alert('사용자 목록을 가져오는 도중 오류가 발생했습니다. 체인맞블락을 중단합니다.')
      gatherer.stop()
    })
    gatherer.on('end', () => {
      ui.finalize()
    })
    const profileUsername = $('.ProfileHeaderCard .username b').text()
    void gatherer.start(profileUsername, currentList)
  }
}
