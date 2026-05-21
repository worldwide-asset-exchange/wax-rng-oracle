import React from 'react';
import ReactDOM from 'react-dom';
import { Router, browserHistory, Route, IndexRoute } from 'react-router';
import axios from 'axios';
import JobList from './jobList.react'
import JobView from './jobView.react'

class NavBar extends React.Component {

  toggleAutoReload(event) {
    this.props.autoreloadChanged(event.target.checked);
  }

  offsetChanged (event) {
    this.props.offsetChanged(event.target.value);
  }

  render() {
    return (
      <nav className="navbar navbar-expand-lg navbar-light bg-light">
        <span className="navbar-brand mb-0 h1">Oracle Job Status</span>
          <button className="navbar-toggler" type="button" data-toggle="collapse" data-target="#navbarSupportedContent" aria-controls="navbarSupportedContent" aria-expanded="false" aria-label="Toggle navigation">
            <span className="navbar-toggler-icon"></span>
          </button>
          <div className="collapse navbar-collapse" id="navbarSupportedContent">
            {this.props.children}
            <ul className="navbar-nav mr-auto"></ul>
            <form className="form-inline my-2 my-lg-0">
              <label htmlFor="offset">Offset:</label>
              <input type="number" min="0" className="form-control" id="offset" step="20" value={this.props.offset} onChange={this.offsetChanged.bind(this)} />
              <input onChange={this.toggleAutoReload.bind(this)} type="checkbox" checked={this.props.autoreloadEnabled} className="form-check-input" id="autoreload" />
              <label className="form-check-label" htmlFor="autoreload">Auto Reload</label>
            </form>
          </div>
        </nav>
    );
  }
}

class App extends React.Component {
  render() {
    return (
      <div className="main ui text container">
        {this.props.children}
      </div>
    )
  }
}

class Application extends React.Component {

  constructor(props){
    super(props);
    this.state = {jobs: [], from: 0, autoreload: true};
  }

  componentWillMount(){
    this.interval = setInterval(this.reloadJobs.bind(this), 2000);
  }

  reloadJobs(){
    if(!this.state.autoreload){
      return;
    }
    axios.get(`/jobs?from=${this.state.from}&limit=20`).then((response) => {
      this.setState({jobs: response.data.jobs});
    });
  }

  componentWillUnmount() {
    clearInterval(this.interval);
  }

  autoreloadChanged(enabled){
    this.setState({autoreload: enabled});
  }

  offsetChanged(newValue) {
    this.setState({from: newValue});
    this.reloadJobs();
  }

  render() {
    return (
        <div>
          <NavBar
            autoreloadEnabled={this.state.autoreload}
            autoreloadChanged={this.autoreloadChanged.bind(this)}
            offset={this.state.from}
            offsetChanged={this.offsetChanged.bind(this)}
          />
          <JobList jobs={this.state.jobs} />
        </div>
    );
  }
}

const routes =  <Route path='/ui/' component={App}>
  <IndexRoute component={Application} />
  <Route path='job/:id' component={JobView} />
</Route>

ReactDOM.render(<Router history={browserHistory} routes={routes} />,
  document.getElementById('content'));
