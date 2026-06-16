import React from 'react'

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null, info: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  componentDidCatch(error, info) {
    console.error('REACT BOUNDARY CAUGHT:', error.message)
    console.error('REACT BOUNDARY STACK:', error.stack)
    console.error('REACT BOUNDARY COMPONENT:', info.componentStack)
    this.setState({ info })
  }
  render() {
    if (this.state.error) {
      return React.createElement('div', {
        style: { padding: '20px', color: '#e4e4e7', background: '#0D1B2A', fontFamily: 'monospace', fontSize: '12px', whiteSpace: 'pre-wrap' }
      }, 'Error: ' + this.state.error.message + '\n\n' + (this.state.info?.componentStack || ''))
    }
    return this.props.children
  }
}